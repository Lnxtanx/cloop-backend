require('dotenv').config({ path: '../.env' })
const prisma = require('../lib/prisma')

async function main() {
  const adminChats = await prisma.admin_chat.findMany({
    include: {
      chat_goal_progress: true
    }
  })

  const stats = {
    total: adminChats.length,
    user: adminChats.filter(c => c.sender === 'user').length,
    ai: adminChats.filter(c => c.sender === 'ai').length,
    userWithProgress: adminChats.filter(c => c.sender === 'user' && c.chat_goal_progress.length > 0).length,
    aiWithProgress: adminChats.filter(c => c.sender === 'ai' && c.chat_goal_progress.length > 0).length,
    orphanedUser: adminChats.filter(c => c.sender === 'user' && c.chat_goal_progress.length === 0).length,
  }

  console.log('ORPHAN_CHECK_RESULT:' + JSON.stringify(stats))
}

main().catch(console.error).finally(() => prisma.$disconnect())
