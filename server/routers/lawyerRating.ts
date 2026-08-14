import { z } from 'zod';
import { eq, and, gte, desc } from 'drizzle-orm';
import { getDb } from '../db';
import { protectedProcedure, router } from '../_core/trpc';
import { lawyerRatings, lawyerInteractions, ratingCalculationLogs, lawyers, cases } from '../schema';
import { nanoid } from 'nanoid';
import { invokeLLM, isLLMProviderConfigured, isLocalLLMProvider, type LLMProvider } from '../llm';
import { getWorkflowPreferences } from '../workflowPreferences';

const responseAnalysisSchema = z.object({
  completenessScore: z.number().finite(),
  professionalismScore: z.number().finite(),
  helpfulnessScore: z.number().finite(),
  clarityScore: z.number().finite(),
  reasoning: z.string(),
  keyPoints: z.array(z.string()),
  concerns: z.array(z.string()),
});

/**
 * AI-Powered Lawyer Rating Service
 * Calculate lawyer ratings based on objective metrics (NOT user ratings)
 * 
 * Rating Components:
 * - Response Time (30%): How quickly lawyers respond
 * - Completeness (40%): Quality of responses (AI-analyzed)
 * - Cooperation (30%): Willingness to take cases
 */

export interface RatingComponents {
  responseTimeScore: number;
  completenessScore: number;
  cooperationScore: number;
  overallRating: number;
}

export interface InteractionData {
  interactionType: string;
  responseTimeHours?: number;
  responseText?: string;
  acceptedCase: boolean;
  declinedCase: boolean;
  providedAlternatives: boolean;
}

/**
 * Record a lawyer interaction for rating calculation
 */
export async function recordLawyerInteraction(data: {
  lawyerId: string;
  caseId: string;
  interactionType: 'initial_outreach' | 'follow_up_1' | 'follow_up_2' | 'lawyer_response' | 'case_acceptance' | 'case_decline' | 'no_response';
  outreachSentAt?: Date;
  responseReceivedAt?: Date;
  responseText?: string;
  acceptedCase?: boolean;
  declinedCase?: boolean;
  providedAlternatives?: boolean;
  askedClarifyingQuestions?: boolean;
  finalOutcome?: 'accepted' | 'declined' | 'no_response' | 'pending';
  outcomeNotes?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const interactionId = nanoid();

  // Calculate response time if both timestamps provided
  let responseTimeHours: number | undefined;
  if (data.outreachSentAt && data.responseReceivedAt) {
    const diffMs = data.responseReceivedAt.getTime() - data.outreachSentAt.getTime();
    responseTimeHours = diffMs / (1000 * 60 * 60); // Convert to hours
  }

  // Analyze response quality with AI if response text provided
  let aiScores: {
    completenessScore?: number;
    professionalismScore?: number;
    helpfulnessScore?: number;
    clarityScore?: number;
    aiAnalysis?: string;
  } = {};

  if (data.responseText && data.responseText.length > 50) {
    try {
      const [caseOwner] = await db.select({ userId: cases.userId }).from(cases).where(eq(cases.id, data.caseId)).limit(1);
      const preferences = caseOwner?.userId ? await getWorkflowPreferences(caseOwner.userId) : null;
      const provider = preferences?.analysisProvider === "local" ? null : preferences?.analysisProvider;
      if (provider && (isLocalLLMProvider(provider) || preferences?.shareRawDocumentContent) && isLLMProviderConfigured(provider)) {
        aiScores = await analyzeResponseQuality(data.responseText, provider);
      }
    } catch (error) {
      console.error('[LawyerRating] AI analysis failed:', error);
      // Continue without AI scores
    }
  }

  // Insert interaction record
  await db.insert(lawyerInteractions).values({
    id: interactionId,
    lawyerId: data.lawyerId,
    caseId: data.caseId,
    interactionType: data.interactionType,
    outreachSentAt: data.outreachSentAt,
    responseReceivedAt: data.responseReceivedAt,
    responseTimeHours: responseTimeHours?.toFixed(2),
    responseText: data.responseText,
    responseLength: data.responseText?.length.toString(),
    completenessScore: aiScores.completenessScore?.toFixed(2),
    professionalismScore: aiScores.professionalismScore?.toFixed(2),
    helpfulnessScore: aiScores.helpfulnessScore?.toFixed(2),
    clarityScore: aiScores.clarityScore?.toFixed(2),
    aiAnalysis: aiScores.aiAnalysis,
    acceptedCase: data.acceptedCase ?? false,
    declinedCase: data.declinedCase ?? false,
    providedAlternatives: data.providedAlternatives ?? false,
    askedClarifyingQuestions: data.askedClarifyingQuestions ?? false,
    finalOutcome: data.finalOutcome ?? 'pending',
    outcomeNotes: data.outcomeNotes,
    analyzedAt: aiScores.completenessScore ? new Date() : null,
  });

  // Trigger rating recalculation
  await calculateLawyerRating(data.lawyerId, 'triggered');

  return interactionId;
}

/**
 * Analyze response quality using AI
 */
async function analyzeResponseQuality(responseText: string, provider: LLMProvider): Promise<{
  completenessScore: number;
  professionalismScore: number;
  helpfulnessScore: number;
  clarityScore: number;
  aiAnalysis: string;
}> {
  const prompt = `You are analyzing a lawyer's response to a case inquiry. Rate the response on these criteria (0-100 scale):

1. **Completeness**: Does the response address all aspects of the inquiry? Does it provide specific information?
2. **Professionalism**: Is the tone professional and appropriate?
3. **Helpfulness**: Does the response demonstrate willingness to help? Are actionable next steps provided?
4. **Clarity**: Is the communication clear and easy to understand?

Response to analyze:
"""
${responseText}
"""

Provide your analysis in JSON format:
{
  "completenessScore": <0-100>,
  "professionalismScore": <0-100>,
  "helpfulnessScore": <0-100>,
  "clarityScore": <0-100>,
  "reasoning": "<brief explanation of scores>",
  "keyPoints": ["<positive aspect 1>", "<positive aspect 2>"],
  "concerns": ["<concern 1 if any>"]
}`;

  const response = await invokeLLM({
    provider,
    messages: [
      { role: 'system', content: 'You are an expert at analyzing legal professional communications.' },
      { role: 'user', content: prompt }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'response_analysis',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            completenessScore: { type: 'number' },
            professionalismScore: { type: 'number' },
            helpfulnessScore: { type: 'number' },
            clarityScore: { type: 'number' },
            reasoning: { type: 'string' },
            keyPoints: { type: 'array', items: { type: 'string' } },
            concerns: { type: 'array', items: { type: 'string' } }
          },
          required: ['completenessScore', 'professionalismScore', 'helpfulnessScore', 'clarityScore', 'reasoning', 'keyPoints', 'concerns'],
          additionalProperties: false
        }
      }
    }
  });

  const content = response.choices[0]?.message.content;
  const rawContent = typeof content === 'string'
    ? content
    : (content || [])
        .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
  const analysis = responseAnalysisSchema.parse(JSON.parse(rawContent || '{}'));

  return {
    completenessScore: Math.min(100, Math.max(0, analysis.completenessScore)),
    professionalismScore: Math.min(100, Math.max(0, analysis.professionalismScore)),
    helpfulnessScore: Math.min(100, Math.max(0, analysis.helpfulnessScore)),
    clarityScore: Math.min(100, Math.max(0, analysis.clarityScore)),
    aiAnalysis: JSON.stringify({
      reasoning: analysis.reasoning,
      keyPoints: analysis.keyPoints,
      concerns: analysis.concerns
    })
  };
}

/**
 * Calculate lawyer rating from all interactions
 */
export async function calculateLawyerRating(
  lawyerId: string,
  calculationType: 'scheduled' | 'triggered' | 'manual' = 'triggered'
): Promise<RatingComponents> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get all interactions for this lawyer
  const interactions = await db
    .select()
    .from(lawyerInteractions)
    .where(eq(lawyerInteractions.lawyerId, lawyerId))
    .orderBy(desc(lawyerInteractions.createdAt));

  if (interactions.length === 0) {
    // No interactions yet, return default scores
    return {
      responseTimeScore: 0,
      completenessScore: 0,
      cooperationScore: 0,
      overallRating: 0
    };
  }

  // Calculate component scores
  const responseTimeScore = calculateResponseTimeScore(interactions);
  const completenessScore = calculateCompletenessScore(interactions);
  const cooperationScore = calculateCooperationScore(interactions);

  // Calculate overall rating (weighted average)
  const overallRating = 
    (responseTimeScore * 0.30) +
    (completenessScore * 0.40) +
    (cooperationScore * 0.30);

  // Determine confidence level
  const confidence = interactions.length < 3 ? 'low' : interactions.length < 10 ? 'medium' : 'high';

  // Calculate detailed metrics
  const metrics = calculateDetailedMetrics(interactions);

  // Get previous rating for comparison
  const previousRatingResult = await db
    .select()
    .from(lawyerRatings)
    .where(eq(lawyerRatings.lawyerId, lawyerId))
    .limit(1);

  const previousRating = previousRatingResult.length > 0 
    ? parseFloat(previousRatingResult[0].overallRating) 
    : null;

  // Determine trend
  let trend: 'improving' | 'stable' | 'declining' = 'stable';
  if (previousRating !== null) {
    const change = overallRating - previousRating;
    if (change > 5) trend = 'improving';
    else if (change < -5) trend = 'declining';
  }

  // Upsert rating record
  if (previousRatingResult.length > 0) {
    await db
      .update(lawyerRatings)
      .set({
        overallRating: overallRating.toFixed(2),
        totalInteractions: interactions.length.toString(),
        ratingConfidence: confidence,
        responseTimeScore: responseTimeScore.toFixed(2),
        completenessScore: completenessScore.toFixed(2),
        cooperationScore: cooperationScore.toFixed(2),
        ...metrics,
        ratingTrend: trend,
        lastCalculatedAt: new Date(),
        lastInteractionAt: interactions[0].createdAt,
        updatedAt: new Date(),
      })
      .where(eq(lawyerRatings.lawyerId, lawyerId));
  } else {
    await db.insert(lawyerRatings).values({
      id: nanoid(),
      lawyerId,
      overallRating: overallRating.toFixed(2),
      totalInteractions: interactions.length.toString(),
      ratingConfidence: confidence,
      responseTimeScore: responseTimeScore.toFixed(2),
      completenessScore: completenessScore.toFixed(2),
      cooperationScore: cooperationScore.toFixed(2),
      ...metrics,
      ratingTrend: trend,
      lastCalculatedAt: new Date(),
      lastInteractionAt: interactions[0].createdAt,
    });
  }

  // Log calculation
  await db.insert(ratingCalculationLogs).values({
    id: nanoid(),
    lawyerId,
    calculationType,
    interactionsAnalyzed: interactions.length.toString(),
    previousRating: previousRating?.toFixed(2),
    newRating: overallRating.toFixed(2),
    ratingChange: previousRating ? (overallRating - previousRating).toFixed(2) : null,
    responseTimeComponent: responseTimeScore.toFixed(2),
    completenessComponent: completenessScore.toFixed(2),
    cooperationComponent: cooperationScore.toFixed(2),
    calculationDetails: JSON.stringify({
      totalInteractions: interactions.length,
      confidence,
      trend,
      metrics
    }),
    triggeredBy: 'system',
  });

  return {
    responseTimeScore,
    completenessScore,
    cooperationScore,
    overallRating
  };
}

/**
 * Calculate response time score (30% weight)
 */
function calculateResponseTimeScore(interactions: any[]): number {
  const responsesWithTime = interactions.filter(i => i.responseTimeHours);
  
  if (responsesWithTime.length === 0) return 0;

  const avgResponseTime = responsesWithTime.reduce((sum, i) => 
    sum + parseFloat(i.responseTimeHours), 0) / responsesWithTime.length;

  // Score based on average response time
  if (avgResponseTime <= 48) return 100;
  if (avgResponseTime <= 168) return 70; // 7 days
  if (avgResponseTime <= 336) return 40; // 14 days
  return 0;
}

/**
 * Calculate completeness score (40% weight)
 */
function calculateCompletenessScore(interactions: any[]): number {
  const analyzed = interactions.filter(i => i.completenessScore);
  
  if (analyzed.length === 0) {
    // No AI analysis yet, use neutral score for new lawyers
    return 50;
  }

  const avgCompleteness = analyzed.reduce((sum, i) => 
    sum + parseFloat(i.completenessScore), 0) / analyzed.length;

  return avgCompleteness;
}

/**
 * Calculate cooperation score (30% weight)
 */
function calculateCooperationScore(interactions: any[]): number {
  const outcomes = interactions.filter(i => i.finalOutcome !== 'pending');
  
  if (outcomes.length === 0) return 50; // Neutral score for new lawyers

  const accepted = outcomes.filter(i => i.finalOutcome === 'accepted').length;
  const declined = outcomes.filter(i => i.finalOutcome === 'declined').length;
  const noResponse = outcomes.filter(i => i.finalOutcome === 'no_response').length;

  const acceptanceRate = outcomes.length > 0 ? (accepted / outcomes.length) * 100 : 0;

  // Calculate helpfulness score from AI analysis
  const withHelpfulness = interactions.filter(i => i.helpfulnessScore);
  const avgHelpfulness = withHelpfulness.length > 0
    ? withHelpfulness.reduce((sum, i) => sum + parseFloat(i.helpfulnessScore), 0) / withHelpfulness.length
    : 50;

  // Bonus for providing alternatives
  const providedAlternatives = interactions.filter(i => i.providedAlternatives).length;
  const alternativesBonus = (providedAlternatives / interactions.length) * 20;

  // Weighted cooperation score
  const cooperationScore = 
    (acceptanceRate * 0.50) +
    (avgHelpfulness * 0.30) +
    (alternativesBonus * 0.20);

  return Math.min(100, cooperationScore);
}

/**
 * Calculate detailed metrics for storage
 */
function calculateDetailedMetrics(interactions: any[]) {
  const withResponseTime = interactions.filter(i => i.responseTimeHours);
  const avgResponseTime = withResponseTime.length > 0
    ? withResponseTime.reduce((sum, i) => sum + parseFloat(i.responseTimeHours), 0) / withResponseTime.length
    : null;

  const fastResponses = withResponseTime.filter(i => parseFloat(i.responseTimeHours) <= 48).length;
  const mediumResponses = withResponseTime.filter(i => {
    const hours = parseFloat(i.responseTimeHours);
    return hours > 48 && hours <= 168;
  }).length;
  const slowResponses = withResponseTime.filter(i => {
    const hours = parseFloat(i.responseTimeHours);
    return hours > 168 && hours <= 336;
  }).length;
  const verySlowResponses = withResponseTime.filter(i => parseFloat(i.responseTimeHours) > 336).length;

  const withCompleteness = interactions.filter(i => i.completenessScore);
  const avgCompleteness = withCompleteness.length > 0
    ? withCompleteness.reduce((sum, i) => sum + parseFloat(i.completenessScore), 0) / withCompleteness.length
    : null;

  const completeAnswers = withCompleteness.filter(i => parseFloat(i.completenessScore) > 80).length;
  const partialAnswers = withCompleteness.filter(i => {
    const score = parseFloat(i.completenessScore);
    return score >= 50 && score <= 80;
  }).length;
  const incompleteAnswers = withCompleteness.filter(i => parseFloat(i.completenessScore) < 50).length;

  const withHelpfulness = interactions.filter(i => i.helpfulnessScore);
  const avgCooperation = withHelpfulness.length > 0
    ? withHelpfulness.reduce((sum, i) => sum + parseFloat(i.helpfulnessScore), 0) / withHelpfulness.length
    : null;

  const casesAccepted = interactions.filter(i => i.finalOutcome === 'accepted').length;
  const casesDeclined = interactions.filter(i => i.finalOutcome === 'declined').length;
  const casesNoResponse = interactions.filter(i => i.finalOutcome === 'no_response').length;

  const outcomes = interactions.filter(i => i.finalOutcome !== 'pending');
  const acceptanceRate = outcomes.length > 0 
    ? (casesAccepted / outcomes.length) * 100 
    : null;

  return {
    averageResponseTimeHours: avgResponseTime?.toFixed(2),
    fastResponses: fastResponses.toString(),
    mediumResponses: mediumResponses.toString(),
    slowResponses: slowResponses.toString(),
    verySlowResponses: verySlowResponses.toString(),
    averageCompletenessScore: avgCompleteness?.toFixed(2),
    completeAnswers: completeAnswers.toString(),
    partialAnswers: partialAnswers.toString(),
    incompleteAnswers: incompleteAnswers.toString(),
    averageCooperationScore: avgCooperation?.toFixed(2),
    casesAccepted: casesAccepted.toString(),
    casesDeclined: casesDeclined.toString(),
    casesNoResponse: casesNoResponse.toString(),
    acceptanceRate: acceptanceRate?.toFixed(2),
  };
}

/**
 * Get lawyer rating
 */
export async function getLawyerRating(lawyerId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const result = await db
    .select()
    .from(lawyerRatings)
    .where(eq(lawyerRatings.lawyerId, lawyerId))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * Get top-rated lawyers
 */
export async function getTopRatedLawyers(limit: number = 10) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  return await db
    .select()
    .from(lawyerRatings)
    .where(eq(lawyerRatings.ratingConfidence, 'high'))
    .orderBy(desc(lawyerRatings.overallRating))
    .limit(limit);
}

/**
 * Batch recalculate all lawyer ratings (for scheduled jobs)
 */
export async function recalculateAllRatings() {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // Get all lawyers with interactions
  const lawyersWithInteractions = await db
    .select({ lawyerId: lawyerInteractions.lawyerId })
    .from(lawyerInteractions)
    .groupBy(lawyerInteractions.lawyerId);

  const results = [];
  for (const { lawyerId } of lawyersWithInteractions) {
    try {
      const rating = await calculateLawyerRating(lawyerId, 'scheduled');
      results.push({ lawyerId, success: true, rating });
    } catch (error) {
      console.error(`[LawyerRating] Failed to calculate rating for ${lawyerId}:`, error);
      results.push({ lawyerId, success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return results;
}

export const lawyerRatingRouter = router({
  get: protectedProcedure
    .input(z.object({ lawyerId: z.string() }))
    .query(async ({ input }) => getLawyerRating(input.lawyerId)),
  topRated: protectedProcedure
    .input(z.object({ limit: z.number().optional().default(10) }))
    .query(async ({ input }) => getTopRatedLawyers(input.limit)),
});
