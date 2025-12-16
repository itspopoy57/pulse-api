// hash-password.js - Quick script to hash a password for manual database insertion
const bcrypt = require('bcryptjs');

const password = process.argv[2] || 'admin123!@#';

bcrypt.hash(password, 10, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
    process.exit(1);
  }
  
  console.log('\n=================================');
  console.log('Password:', password);
  console.log('Hashed:', hash);
  console.log('=================================\n');
  console.log('Copy the hashed value above and paste it into the passwordHash field in Prisma Studio');
  console.log('\n');
});