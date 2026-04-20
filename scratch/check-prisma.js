const prisma = require('../lib/prisma');
async function check() {
  console.log('Practice Tests fields:', Object.keys(prisma.practice_tests));
  // Try to inspect the dmmf if possible, but simpler is to just check the properties
  const test = await prisma.practice_tests.findFirst({
    include: { _count: true }
  }).catch(e => console.log('Error fetching:', e.message));
  
  process.exit(0);
}
check();
