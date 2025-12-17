import crypto from 'crypto';

/**
 * Generate a 6-digit verification code
 */
export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Generate a secure random token
 */
export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Get verification token expiry time (15 minutes from now)
 */
export function getVerificationExpiry(): Date {
  return new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
}

/**
 * Check if verification token is expired
 */
export function isTokenExpired(expiry: Date | null): boolean {
  if (!expiry) return true;
  return new Date() > expiry;
}

/**
 * Send verification email (placeholder - integrate with your email service)
 * For now, we'll just log it. In production, use SendGrid, AWS SES, etc.
 */
export async function sendVerificationEmail(
  email: string,
  code: string
): Promise<void> {
  // TODO: Integrate with actual email service
  console.log('='.repeat(50));
  console.log('📧 VERIFICATION EMAIL');
  console.log('='.repeat(50));
  console.log(`To: ${email}`);
  console.log(`Verification Code: ${code}`);
  console.log('='.repeat(50));
  
  // In production, replace with actual email service:
  /*
  await emailService.send({
    to: email,
    subject: 'Verify your Hot Takes Arena account',
    html: `
      <h1>Welcome to Hot Takes Arena!</h1>
      <p>Your verification code is: <strong>${code}</strong></p>
      <p>This code will expire in 15 minutes.</p>
    `
  });
  */
}