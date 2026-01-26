const { PrismaClient } = require('../generated/prisma');

console.log('[lib/prisma] PrismaClient type:', typeof PrismaClient);

// Create a single Prisma client instance to be shared across the application
// This avoids connection pool issues and circular dependency problems
const prisma = new PrismaClient({
  log: ['error', 'warn'], // Log errors and warnings
});

console.log('[lib/prisma] Prisma instance created, type:', typeof prisma);
console.log('[lib/prisma] Has contentGenerationStatus:', typeof prisma.content_generation_status);
console.log('[lib/prisma] Has users:', typeof prisma.users);
console.log('[lib/prisma] Keys:', Object.keys(prisma).slice(0, 10));

// Export the client instance
module.exports = prisma;



