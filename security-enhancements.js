// Enhanced security implementation with server-side CSRF protection
// and other security features for Legal AI Reach Out Platform

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss-clean');
const hpp = require('hpp');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const validator = require('validator');

// Initialize CSRF protection
const csrfProtection = csrf({ 
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
});

// Rate limiting configuration
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per windowMs
  message: 'Too many login attempts from this IP, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: 'Too many requests from this IP, please try again after a minute',
  standardHeaders: true,
  legacyHeaders: false,
});

// Security middleware setup
function setupSecurity(app) {
  // Parse cookies for CSRF
  app.use(cookieParser());
  
  // Set security headers with Helmet
  app.use(helmet());
  
  // Prevent parameter pollution
  app.use(hpp());
  
  // Prevent XSS attacks
  app.use(xss());
  
  // Apply rate limiting to login route
  app.use('/api/auth/login', loginLimiter);
  
  // Apply rate limiting to API routes
  app.use('/api', apiLimiter);
  
  // Custom security headers
  app.use((req, res, next) => {
    // Content Security Policy
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://i.ibb.co data:; connect-src 'self' https://danolbza.manus.space; form-action 'self'; upgrade-insecure-requests;"
    );
    
    // Permissions Policy
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );
    
    next();
  });
  
  return app;
}

// Authentication routes with CSRF protection
router.post('/auth/login', csrfProtection, (req, res) => {
  const { email, password } = req.body;
  
  // Input validation
  if (!email || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Email and password are required' 
    });
  }
  
  if (!validator.isEmail(email)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid email format' 
    });
  }
  
  // Password strength validation for registration (not needed for login)
  // if (isRegistration && !isStrongPassword(password)) {
  //   return res.status(400).json({ 
  //     success: false, 
  //     message: 'Password must be at least 8 characters with a mix of letters, numbers, and symbols' 
  //   });
  // }
  
  // In a real app, we would validate credentials against a database
  // For this demo, we'll accept any email/password
  
  // Generate JWT token
  const token = generateToken(email);
  
  // Set secure, httpOnly cookie with the token
  res.cookie('authToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });
  
  res.json({
    success: true,
    user: {
      email,
      role: email.includes('investor') ? 'investor' : 'user'
    }
  });
});

// Logout route
router.post('/auth/logout', csrfProtection, (req, res) => {
  // Clear the auth cookie
  res.clearCookie('authToken');
  
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Protected route example
router.get('/user/profile', authenticateToken, csrfProtection, (req, res) => {
  // In a real app, we would fetch user data from database
  res.json({
    success: true,
    user: req.user
  });
});

// Form submission with CSRF protection and input sanitization
router.post('/submit-form', csrfProtection, (req, res) => {
  // Sanitize all input fields
  // Request keys are untrusted; a null-prototype object prevents special keys
  // such as __proto__ from mutating the sanitization result's prototype.
  const sanitizedData = Object.create(null);
  
  Object.keys(req.body).forEach(key => {
    // Skip CSRF token
    if (key === '_csrf') return;
    
    // Sanitize string inputs
    if (typeof req.body[key] === 'string') {
      sanitizedData[key] = validator.escape(req.body[key]);
    } else {
      sanitizedData[key] = req.body[key];
    }
  });
  
  // In a real app, we would process the form data
  // For this demo, we'll just echo it back
  res.json({
    success: true,
    message: 'Form submitted successfully',
    data: sanitizedData
  });
});

// Case submission with CSRF protection and input sanitization
router.post('/submit-case', csrfProtection, (req, res) => {
  const { caseDescription, legalField } = req.body;
  
  // Input validation
  if (!caseDescription) {
    return res.status(400).json({ 
      success: false, 
      message: 'Case description is required' 
    });
  }
  
  // Sanitize inputs
  const sanitizedDescription = validator.escape(caseDescription);
  const sanitizedLegalField = legalField ? validator.escape(legalField) : null;
  
  // In a real app, we would process the case with AI and store in database
  // For this demo, we'll just echo it back with a mock response
  res.json({
    success: true,
    message: 'Case submitted successfully',
    caseId: 'CASE-' + Date.now(),
    estimatedTimeToLawyer: '3-4 hours',
    suggestedLegalFields: sanitizedLegalField ? [sanitizedLegalField] : ['Contract Law', 'Employment Law']
  });
});

// Helper functions

// Generate JWT token
function generateToken(email) {
  // In a real app, we would use a proper JWT library
  // For this demo, we'll create a simple token
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };
  
  const payload = {
    sub: email,
    role: email.includes('investor') ? 'investor' : 'user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
  };
  
  const base64Header = Buffer.from(JSON.stringify(header)).toString('base64').replace(/=/g, '');
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=/g, '');
  
  const secret = process.env.JWT_SECRET || 'your-secret-key';
  
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${base64Header}.${base64Payload}`)
    .digest('base64')
    .replace(/=/g, '');
  
  return `${base64Header}.${base64Payload}.${signature}`;
}

// Authenticate JWT token middleware
function authenticateToken(req, res, next) {
  const token = req.cookies.authToken;
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  
  try {
    // In a real app, we would verify the token with a JWT library
    // For this demo, we'll parse it manually
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    
    // Check if token is expired
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }
    
    // Set user info in request
    req.user = {
      email: payload.sub,
      role: payload.role
    };
    
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid or expired token' 
    });
  }
}

// Check if password is strong
function isStrongPassword(password) {
  // At least 8 characters
  if (password.length < 8) return false;
  
  // Check for at least one lowercase letter
  if (!/[a-z]/.test(password)) return false;
  
  // Check for at least one uppercase letter
  if (!/[A-Z]/.test(password)) return false;
  
  // Check for at least one number
  if (!/[0-9]/.test(password)) return false;
  
  // Check for at least one special character
  if (!/[^a-zA-Z0-9]/.test(password)) return false;
  
  return true;
}

module.exports = {
  router,
  setupSecurity,
  csrfProtection,
  authenticateToken
};
