"""
Serverless Function Implementations for Legal AI Platform

This module implements specific serverless functions for the Legal AI Platform,
including case processing, document handling, and user management functions.
"""

import os
import json
import time
import logging
from typing import Dict, List, Any, Optional

from serverless_architecture import serverless_function, event_handler, publish_event
from db_optimization import db_manager
from timeseries_manager import timeseries_manager
from document_intelligence import DocumentIntelligenceEngine
from lawyer_matching import LawyerMatchingEngine
from outreach_target_matching import OutreachTargetEngine

# Configure logging
logger = logging.getLogger('legal_ai_platform.serverless_functions')
document_intelligence = DocumentIntelligenceEngine()
lawyer_matching_engine = LawyerMatchingEngine()
outreach_target_engine = OutreachTargetEngine()

# Case Processing Functions
@serverless_function(options={
    'timeout': 60000,  # 60 seconds
    'memory_size': 256,  # 256 MB
    'events': [
        {'type': 'case.created'}
    ]
})
def process_new_case(payload, context):
    """
    Process a newly created case
    
    This function is triggered when a new case is created and performs
    initial processing such as categorization, complexity analysis,
    and lawyer matching.
    """
    case_id = payload.get('case_id')
    logger.info("Processing new case %s", case_id)
    if not case_id:
        return {
            'statusCode': 400,
            'body': {'error': 'Case ID is required'}
        }
    
    try:
        # Get case data
        case_data = payload.get('case_data', {})
        
        # Perform case processing
        start_time = time.time()
        
        # 1. Analyze case complexity
        complexity = analyze_case_complexity(case_data.get('description', ''))
        
        # 2. Match legal fields
        legal_fields = match_legal_fields(case_data.get('description', ''))
        
        # 3. Generate case summary
        summary = generate_case_summary(case_data.get('description', ''))
        
        # 4. Calculate processing time
        processing_time = time.time() - start_time
        
        # Record processing metrics
        timeseries_manager.record_case_event(
            case_id=str(case_id),
            event_type='processed',
            category=legal_fields[0] if legal_fields else 'UNKNOWN',
            details={
                'complexity': complexity,
                'processing_time': processing_time,
                'field_count': len(legal_fields)
            }
        )
        
        # Return processed case data
        return {
            'statusCode': 200,
            'body': {
                'case_id': case_id,
                'complexity': complexity,
                'legal_fields': legal_fields,
                'summary': summary,
                'processing_time': processing_time
            }
        }
    
    except Exception as e:
        logger.error("Case processing failed (%s)", type(e).__name__)
        
        # Record error
        timeseries_manager.record_system_metric(
            metric_type='error',
            value=1.0,
            component='process_new_case',
            details={
                'case_id': case_id,
                'error': type(e).__name__
            }
        )
        
        return {
            'statusCode': 500,
            'body': {'error': 'Error processing case'}
        }

def analyze_case_complexity(description):
    """Analyze case complexity based on description"""
    # In a real implementation, this would use NLP to analyze complexity
    # For this example, we'll use a simple heuristic based on text length
    if not description:
        return 'low'
    
    word_count = len(description.split())
    
    if word_count > 500:
        return 'high'
    elif word_count > 200:
        return 'medium'
    else:
        return 'low'

def match_legal_fields(description):
    """Match legal fields based on description"""
    # In a real implementation, this would use NLP to match legal fields
    # For this example, we'll use simple keyword matching
    legal_fields = []
    
    keywords = {
        'FAMILY_LAW': ['divorce', 'custody', 'child support', 'alimony', 'marriage'],
        'CRIMINAL_LAW': ['arrest', 'charge', 'crime', 'criminal', 'defense'],
        'CONTRACT_LAW': ['contract', 'agreement', 'breach', 'terms', 'clause'],
        'PROPERTY_LAW': ['property', 'real estate', 'landlord', 'tenant', 'lease'],
        'EMPLOYMENT_LAW': ['employment', 'worker', 'discrimination', 'harassment', 'termination']
    }
    
    for field, field_keywords in keywords.items():
        for keyword in field_keywords:
            if keyword.lower() in description.lower():
                legal_fields.append(field)
                break
    
    # If no fields matched, return a default
    if not legal_fields:
        legal_fields = ['GENERAL_LAW']
    
    return legal_fields

def generate_case_summary(description):
    """Generate a summary of the case"""
    # In a real implementation, this would use NLP to generate a summary
    # For this example, we'll use a simple truncation
    if not description:
        return 'No description provided'
    
    words = description.split()
    if len(words) <= 50:
        return description
    
    return ' '.join(words[:50]) + '...'

# Document Processing Functions
@serverless_function(options={
    'timeout': 120000,  # 120 seconds
    'memory_size': 512,  # 512 MB
})
def process_document(payload, context):
    """
    Process a document
    
    This function processes a document, extracting text, analyzing content,
    and generating metadata.
    """
    document_id = payload.get('document_id')
    document_data = payload.get('document_data', {})
    logger.info(
        "Processing document %s for case %s (%s)",
        document_id,
        document_data.get('case_id'),
        document_data.get('document_name') or document_data.get('file_name') or 'unnamed',
    )
    if not document_id:
        return {
            'statusCode': 400,
            'body': {'error': 'Document ID is required'}
        }
    
    try:
        # Get document data
        case_id = document_data.get('case_id')
        
        # Perform document processing
        start_time = time.time()
        
        # 1. Extract text from document
        text = extract_document_text(document_data)
        
        # 2. Analyze document content
        analysis = analyze_document_content(text)
        
        # 3. Generate document metadata
        metadata = generate_document_metadata(text, analysis)
        
        # 4. Calculate processing time
        processing_time = time.time() - start_time
        
        # Record processing metrics
        if case_id:
            timeseries_manager.record_case_event(
                case_id=str(case_id),
                event_type='document_processed',
                category=document_data.get('type', 'UNKNOWN'),
                details={
                    'document_id': document_id,
                    'processing_time': processing_time,
                    'content_length': len(text)
                }
            )
        
        # Return processed document data
        return {
            'statusCode': 200,
            'body': {
                'document_id': document_id,
                'case_id': case_id,
                'text_length': len(text),
                'analysis': analysis,
                'metadata': metadata,
                'processing_time': processing_time
            }
        }
    
    except Exception as e:
        logger.error("Document processing failed (%s)", type(e).__name__)
        
        # Record error
        timeseries_manager.record_system_metric(
            metric_type='error',
            value=1.0,
            component='process_document',
            details={
                'document_id': document_id,
                'error': type(e).__name__
            }
        )
        
        return {
            'statusCode': 500,
            'body': {'error': 'Error processing document'}
        }

def extract_document_text(document_data):
    """Extract text from document content"""
    if isinstance(document_data, str):
        document_data = {'content': document_data}
    return document_intelligence.extract_text_from_document(document_data or {})

def analyze_document_content(text):
    """Analyze document content"""
    word_count = len(text.split())
    sentence_count = len([part for part in text.split('.') if part.strip()])
    legal_analysis = document_intelligence.analyze_text(text)
    
    return {
        'word_count': word_count,
        'sentence_count': sentence_count,
        'average_words_per_sentence': word_count / max(sentence_count, 1),
        'legal_analysis': legal_analysis
    }

def generate_document_metadata(text, analysis):
    """Generate document metadata"""
    legal_analysis = analysis.get('legal_analysis', {})
    return {
        'length': len(text),
        'complexity': 'high' if analysis['average_words_per_sentence'] > 20 else 'medium' if analysis['average_words_per_sentence'] > 10 else 'low',
        'document_type': legal_analysis.get('document_type', 'unknown'),
        'topics': legal_analysis.get('topics', []),
        'relevance_score': legal_analysis.get('evidence', {}).get('relevance_score', 0.0),
        'confidence': legal_analysis.get('processing', {}).get('confidence', 'low'),
        'timestamp': time.time()
    }

# User Activity Functions
@event_handler('user.login')
def handle_user_login(event_data):
    """
    Handle user login event
    
    This function is triggered when a user logs in and performs
    actions such as updating last login time and recording metrics.
    """
    logger.info(f"Handling user login: {event_data}")
    
    user_id = event_data.get('user_id')
    if not user_id:
        logger.error("User ID is required")
        return {'error': 'User ID is required'}
    
    try:
        # Record user activity
        timeseries_manager.record_user_activity(
            user_id=str(user_id),
            activity_type='login',
            details={
                'ip_address': event_data.get('ip_address'),
                'user_agent': event_data.get('user_agent')
            }
        )
        
        # Update user last login time
        # In a real implementation, this would update the database
        
        return {
            'user_id': user_id,
            'processed': True,
            'timestamp': time.time()
        }
    
    except Exception as e:
        logger.error("User login event failed (%s)", type(e).__name__)
        
        # Record error
        timeseries_manager.record_system_metric(
            metric_type='error',
            value=1.0,
            component='handle_user_login',
            details={
                'user_id': user_id,
                'error': type(e).__name__
            }
        )
        
        return {'error': 'User login event failed'}

@event_handler('user.search')
def handle_user_search(event_data):
    """
    Handle user search event
    
    This function is triggered when a user performs a search and
    records search metrics and improves search results.
    """
    logger.info(f"Handling user search: {event_data}")
    
    user_id = event_data.get('user_id')
    query = event_data.get('query')
    
    if not user_id or not query:
        logger.error("User ID and query are required")
        return {'error': 'User ID and query are required'}
    
    try:
        # Record user activity
        timeseries_manager.record_user_activity(
            user_id=str(user_id),
            activity_type='search',
            details={
                'query': query,
                'filters': event_data.get('filters', {})
            }
        )
        
        # Process search query
        # In a real implementation, this would improve search results
        
        return {
            'user_id': user_id,
            'query': query,
            'processed': True,
            'timestamp': time.time()
        }
    
    except Exception as e:
        logger.error("User search event failed (%s)", type(e).__name__)
        
        # Record error
        timeseries_manager.record_system_metric(
            metric_type='error',
            value=1.0,
            component='handle_user_search',
            details={
                'user_id': user_id,
                'query': query,
                'error': type(e).__name__
            }
        )
        
        return {'error': 'User search event failed'}

# Lawyer Matching Functions
@serverless_function(options={
    'timeout': 60000,  # 60 seconds
    'memory_size': 256,  # 256 MB
})
def match_lawyers(payload, context):
    """
    Match lawyers to a case
    
    This function matches lawyers to a case based on case details
    and lawyer specializations.
    """
    case_id = payload.get('case_id')
    logger.info(
        "Matching lawyers for case %s with %s provided candidates",
        case_id,
        len(payload.get('candidate_lawyers') or []),
    )
    if not case_id:
        return {
            'statusCode': 400,
            'body': {'error': 'Case ID is required'}
        }
    
    try:
        case_data = payload.get('case_data', {})
        match_preferences = payload.get('match_preferences', {})
        match_input = {
            **case_data,
            **match_preferences,
            'max_results': payload.get('max_results') or match_preferences.get('max_results') or case_data.get('max_results') or 30
        }
        legal_fields = match_input.get('legal_fields', [])
        
        # Perform lawyer matching
        start_time = time.time()
        match_result = lawyer_matching_engine.match(
            match_input,
            records=payload.get('candidate_lawyers'),
            max_results=payload.get('max_results')
        )
        ranked_lawyers = match_result['matched_lawyers']
        
        processing_time = time.time() - start_time
        
        # Record processing metrics
        timeseries_manager.record_case_event(
            case_id=str(case_id),
            event_type='lawyers_matched',
            category=legal_fields[0] if legal_fields else 'UNKNOWN',
            details={
                'lawyer_count': len(ranked_lawyers),
                'processing_time': processing_time,
                'source_mode': match_result.get('source_mode'),
                'nova_search_url': match_result.get('nova_search_url'),
                'source_details': match_result.get('source_details'),
                'search_criteria': match_result.get('search_criteria')
            }
        )
        
        # Return matched lawyers
        return {
            'statusCode': 200,
            'body': {
                'case_id': case_id,
                'matched_lawyers': ranked_lawyers,
                'search_criteria': match_result.get('search_criteria'),
                'case_profile': match_result.get('case_profile'),
                'source_mode': match_result.get('source_mode'),
                'nova_search_url': match_result.get('nova_search_url'),
                'source_details': match_result.get('source_details'),
                'available_count': match_result.get('available_count'),
                'processing_time': processing_time
            }
        }
    
    except Exception as e:
        logger.error("Lawyer matching failed (%s)", type(e).__name__)
        
        # Record error
        timeseries_manager.record_system_metric(
            metric_type='error',
            value=1.0,
            component='match_lawyers',
            details={
                'case_id': case_id,
                'error': type(e).__name__
            }
        )
        
        return {
            'statusCode': 500,
            'body': {'error': 'Error matching lawyers'}
        }

def find_matching_lawyers(legal_fields):
    """Find lawyers with matching specializations."""
    result = lawyer_matching_engine.match({'legal_fields': legal_fields, 'max_results': 200})
    return result['matched_lawyers']

def rank_lawyers_by_relevance(lawyers, case_data):
    """Rank lawyers by relevance to the case."""
    result = lawyer_matching_engine.match(case_data or {}, records=lawyers, max_results=len(lawyers) or 30)
    return result['matched_lawyers']

@serverless_function(options={
    'timeout': 60000,
    'memory_size': 256,
})
def match_outreach_targets(payload, context):
    """Match media or organization outreach targets to a case."""
    case_id = payload.get('case_id')
    logger.info(
        "Matching %s outreach targets for case %s with %s provided candidates",
        payload.get('target_type') or 'media',
        case_id,
        len(payload.get('candidate_targets') or []),
    )
    if not case_id:
        return {
            'statusCode': 400,
            'body': {'error': 'Case ID is required'}
        }

    try:
        case_data = payload.get('case_data', {})
        match_preferences = payload.get('match_preferences', {})
        target_type = payload.get('target_type') or match_preferences.get('target_type') or case_data.get('target_type') or 'media'
        match_input = {
            **case_data,
            **match_preferences,
            'target_type': target_type,
            'max_results': payload.get('max_results') or match_preferences.get('max_results') or case_data.get('max_results') or 30
        }

        start_time = time.time()
        match_result = outreach_target_engine.match(
            match_input,
            records=payload.get('candidate_targets'),
            max_results=payload.get('max_results'),
            source_mode_override=payload.get('candidate_source_mode'),
            source_details_override=payload.get('candidate_source_details'),
        )
        processing_time = time.time() - start_time

        timeseries_manager.record_case_event(
            case_id=str(case_id),
            event_type=f'{target_type}_targets_matched',
            category=target_type,
            details={
                'target_count': len(match_result.get('matched_targets', [])),
                'processing_time': processing_time,
                'source_mode': match_result.get('source_mode'),
                'search_criteria': match_result.get('search_criteria')
            }
        )

        return {
            'statusCode': 200,
            'body': {
                'case_id': case_id,
                **match_result,
                'processing_time': processing_time
            }
        }

    except Exception as e:
        logger.error("Outreach matching failed (%s)", type(e).__name__)
        timeseries_manager.record_system_metric(
            metric_type='error',
            value=1.0,
            component='match_outreach_targets',
            details={
                'case_id': case_id,
                'error': type(e).__name__
            }
        )

        return {
            'statusCode': 500,
            'body': {'error': 'Error matching outreach targets'}
        }

# Initialize serverless functions
def init_serverless_functions():
    """Initialize all serverless functions"""
    logger.info("Initializing serverless functions")
    
    # The functions are already registered via decorators,
    # but we can perform additional initialization here if needed
    
    logger.info("Serverless functions initialized")

# Example of publishing events
def publish_case_created_event(case_id, case_data):
    """Publish a case.created event"""
    return publish_event('case.created', {
        'case_id': case_id,
        'case_data': case_data,
        'timestamp': time.time()
    })

def publish_user_login_event(user_id, ip_address, user_agent):
    """Publish a user.login event"""
    return publish_event('user.login', {
        'user_id': user_id,
        'ip_address': ip_address,
        'user_agent': user_agent,
        'timestamp': time.time()
    })

def publish_user_search_event(user_id, query, filters=None):
    """Publish a user.search event"""
    return publish_event('user.search', {
        'user_id': user_id,
        'query': query,
        'filters': filters or {},
        'timestamp': time.time()
    })
