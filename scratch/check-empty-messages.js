const { PrismaClient } = require('../generated/prisma');
const prisma = new PrismaClient();

async function main() {
  try {
    const nullMessages = await prisma.admin_chat.findMany({
      where: {
        OR: [
          { message: null },
          { message: '' }
        ]
      },
      select: {
        id: true,
        user_id: true,
        sender: true,
        message: true,
        message_type: true,
        created_at: true
      }
    });

    console.log(`🔍 Found ${nullMessages.length} null or empty messages:`);
    console.log(JSON.stringify(nullMessages, null, 2));

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
