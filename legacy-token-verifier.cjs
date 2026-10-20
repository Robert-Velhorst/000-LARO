const crypto = require('node:crypto');
const validator = require('validator');

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes');
  }
  return secret;
}

function authenticateToken(req, res, next) {
  const token = req.cookies.authToken;
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  
  try {
    if (typeof token !== 'string') {
      throw new Error('Invalid token format');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const secret = getJwtSecret();
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const providedSignature = Buffer.from(encodedSignature, 'base64url');

    if (providedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(providedSignature, expectedSignature)) {
      throw new Error('Invalid token signature');
    }

    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new Error('Unsupported token algorithm');
    }
    
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    
    if (typeof payload.sub !== 'string' || !validator.isEmail(payload.sub) ||
        !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }

    // Earlier demo logins granted investor access from the email address.
    // Reject those still-signed tokens immediately instead of retaining their
    // elevated claim until expiry. This router only issues ordinary user tokens.
    if (payload.role !== 'user') {
      throw new Error('Legacy privileged tokens are no longer accepted');
    }
    
    // Set user info in request
    req.user = {
      email: payload.sub.trim().toLowerCase(),
      role: 'user'
    };
    
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid or expired token' 
    });
  }
}

module.exports = { getJwtSecret, authenticateToken };
