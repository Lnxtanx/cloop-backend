const { PrismaClient } = require('./generated/prisma');
const prisma = new PrismaClient();

async function main() {
  try {
    const users = await prisma.users.findMany({ take: 1 });
    console.log('Successfully connected! User count:', users.length);
  } catch (err) {
    console.error('Connection failed:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
