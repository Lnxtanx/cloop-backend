const prisma = require('../lib/prisma');
const { ensureGlobalCurriculum, enrollUserInSubject } = require('./global-curriculum-pipeline');

/**
 * Handle user signup and enroll into global curriculum
 */
async function handleUserSignup(userId) {
  try {
    console.log(`Setting up global curriculum enrollment for new user: ${userId}`);

    // Get user details
    const user = await prisma.users.findUnique({
      where: { user_id: userId }
    });

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    const gradeLevel = user.grade_level;
    const board = user.board;

    if (!gradeLevel || !board) {
      console.log(`User ${userId} has incomplete profile, skipping content generation setup`);
      return {
        success: false,
        message: 'User profile incomplete. Grade level and board are required.'
      };
    }

    // Get user's subjects (check user_subject_enrollments or subjects table)
    let subjectNames = [];

    // Check if user has legacy subjects array
    if (user.subjects && user.subjects.length > 0) {
      const subjectRecords = await prisma.subjects.findMany({
        where: {
          OR: [
            { code: { in: user.subjects } },
            { name: { in: user.subjects } }
          ]
        },
        select: { name: true, code: true, category: true }
      });
      subjectNames = subjectRecords;
    }

    // Fallback: check deprecated user_subjects table
    if (subjectNames.length === 0) {
      const userSubjects = await prisma.user_subjects.findMany({
        where: { user_id: userId },
        include: {
          subjects: {
            select: { id: true, name: true, code: true, category: true }
          }
        }
      });
      subjectNames = userSubjects.map(us => us.subjects).filter(Boolean);
    }

    if (subjectNames.length === 0) {
      console.log(`User ${userId} has no subjects, skipping content generation setup`);
      return {
        success: false,
        message: 'User has no subjects assigned.'
      };
    }

    const enrolledStatuses = [];

    for (const sub of subjectNames) {
      try {
        // 1. Find or create global_subject
        let globalSubject = await prisma.global_subjects.findUnique({
          where: {
            board_grade_name: {
              board: board,
              grade: gradeLevel,
              name: sub.name
            }
          }
        });

        if (!globalSubject) {
          globalSubject = await prisma.global_subjects.create({
            data: {
              board: board,
              grade: gradeLevel,
              name: sub.name,
              code: sub.code,
              category: sub.category
            }
          });

          // Create pending status in global_curriculum_status
          await prisma.global_curriculum_status.upsert({
            where: {
              board_grade_subject_name: {
                board: board,
                grade: gradeLevel,
                subject_name: sub.name
              }
            },
            update: {
              global_subject_id: globalSubject.id,
              status: 'pending'
            },
            create: {
              board: board,
              grade: gradeLevel,
              subject_name: sub.name,
              global_subject_id: globalSubject.id,
              status: 'pending'
            }
          });

          // Trigger generation asynchronously in background
          ensureGlobalCurriculum(board, gradeLevel, sub.name, sub.code, sub.category)
            .then(() => console.log(`✓ Global curriculum generated for ${board} ${gradeLevel} ${sub.name}`))
            .catch(err => console.error(`Error in async global curriculum gen for ${sub.name}:`, err.message));
        }

        // 2. Enroll user in global subject
        await enrollUserInSubject(userId, globalSubject.id);

        enrolledStatuses.push({
          subject: sub.name,
          globalSubjectId: globalSubject.id
        });

        console.log(`✓ Enrolled user ${userId} in global subject: ${sub.name}`);
      } catch (subErr) {
        console.error(`Error enrolling user ${userId} in ${sub.name}:`, subErr);
      }
    }

    console.log(`Global curriculum setup complete for user ${userId}. Enrolled in ${enrolledStatuses.length} subject(s).`);

    return {
      success: true,
      message: `Enrolled in ${enrolledStatuses.length} subject(s)`,
      statuses: enrolledStatuses
    };

  } catch (error) {
    console.error('Error in handleUserSignup:', error);
    throw error;
  }
}

/**
 * Handle profile update and create pending content generation records for new subjects
 */
async function handleProfileUpdate(userId, updateData) {
  try {
    return await handleUserSignup(userId);
  } catch (error) {
    console.error('Error in handleProfileUpdate:', error);
    throw error;
  }
}

module.exports = {
  handleUserSignup,
  handleProfileUpdate
};


