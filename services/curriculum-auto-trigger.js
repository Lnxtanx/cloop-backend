const prisma = require('../lib/prisma');

/**
 * Handle user signup and create pending content generation records
 */
async function handleUserSignup(userId) {
  try {
    console.log(`Setting up content generation for new user: ${userId}`);

    // Get user details
    const user = await prisma.users.findUnique({
      where: { user_id: userId }
    });

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    // Resolve grade level record from the user's stored grade name
    // The frontend now stores grade name in users.grade_level (e.g., "Grade 6").
    // Use findFirst since `name` is not unique in the schema.
    const gradeLevelRecord = user.grade_level
      ? await prisma.grade_levels.findFirst({ where: { name: user.grade_level } })
      : null;

    if (!gradeLevelRecord || !user.board) {
      console.log(`User ${userId} has incomplete profile, skipping content generation setup`);
      return {
        success: false,
        message: 'User profile incomplete. Grade level and board are required.'
      };
    }

    // Get user's subjects
    const userSubjects = await prisma.user_subjects.findMany({
      where: { user_id: userId },
      include: {
        subjects: {
          select: {
            id: true,
            name: true,
            code: true
          }
        }
      }
    });

    if (userSubjects.length === 0) {
      console.log(`User ${userId} has no subjects, skipping content generation setup`);
      return {
        success: false,
        message: 'User has no subjects assigned.'
      };
    }

    // Create pending content generation status for each subject
    const createdStatuses = [];
    for (const userSubject of userSubjects) {
      try {
        const status = await prisma.content_generation_status.upsert({
          where: {
            user_id_subject_id_grade_level_board: {
              user_id: userId,
              subject_id: userSubject.subject_id,
              // store and compare using the grade name
              grade_level: gradeLevelRecord.name,
              board: user.board
            }
          },
          update: {
            status: 'pending',
            updated_at: new Date()
          },
          create: {
            user_id: userId,
            subject_id: userSubject.subject_id,
            grade_level: gradeLevelRecord.name,
            board: user.board,
            status: 'pending',
            chapters_generated: false,
            topics_generated: false,
            goals_generated: false
          }
        });

        createdStatuses.push({
          subject: userSubject.subjects.name,
          status: status.status
        });

        console.log(`✓ Created pending status for subject: ${userSubject.subjects.name}`);
      } catch (error) {
        console.error(`Error creating status for subject ${userSubject.subject_id}:`, error);
      }
    }

    console.log(`Content generation setup complete for user ${userId}. Created ${createdStatuses.length} pending task(s).`);
    console.log('Content will be generated when the backend starts or through the content generation API.');

    return {
      success: true,
      message: `Content generation scheduled for ${createdStatuses.length} subject(s)`,
      statuses: createdStatuses
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
    console.log(`Checking content generation setup after profile update for user: ${userId}`);

    // Get updated user details
    const user = await prisma.users.findUnique({
      where: { user_id: userId }
    });

    if (!user) {
      throw new Error(`User ${userId} not found`);
    }

    // Resolve grade level record from the user's stored grade code
    const gradeLevelRecord = user.grade_level
      ? await prisma.grade_levels.findFirst({ where: { name: user.grade_level } })
      : null;

    if (!gradeLevelRecord || !user.board) {
      console.log(`User ${userId} still has incomplete profile, skipping content generation setup`);
      return {
        success: false,
        message: 'User profile incomplete. Grade level and board are required.'
      };
    }

    // Get user's subjects from user_subjects table
    const userSubjects = await prisma.user_subjects.findMany({
      where: { user_id: userId },
      include: {
        subjects: {
          select: {
            id: true,
            name: true,
            code: true
          }
        }
      }
    });

    if (userSubjects.length === 0) {
      console.log(`User ${userId} has no subjects, skipping content generation setup`);
      return {
        success: false,
        message: 'User has no subjects assigned.'
      };
    }

    // Create or update pending content generation status for each subject
    const createdStatuses = [];
    for (const userSubject of userSubjects) {
      try {
        // Check if content generation status already exists
                const existingStatus = await prisma.content_generation_status.findUnique({
          where: {
            user_id_subject_id_grade_level_board: {
              user_id: userId,
              subject_id: userSubject.subject_id,
              grade_level: gradeLevelRecord.name,
              board: user.board
            }
          }
        });

        // Only create if it doesn't exist or if it failed previously
        if (!existingStatus || existingStatus.status === 'failed') {
          const status = await prisma.content_generation_status.upsert({
            where: {
              user_id_subject_id_grade_level_board: {
                user_id: userId,
                subject_id: userSubject.subject_id,
                grade_level: gradeLevelRecord.name,
                board: user.board
              }
            },
            update: {
              status: 'pending',
              updated_at: new Date()
            },
            create: {
              user_id: userId,
              subject_id: userSubject.subject_id,
              grade_level: gradeLevelRecord.name,
              board: user.board,
              status: 'pending',
              chapters_generated: false,
              topics_generated: false,
              goals_generated: false
            }
          });

          createdStatuses.push({
            subject: userSubject.subjects.name,
            status: status.status
          });

          console.log(`✓ Created/updated pending status for subject: ${userSubject.subjects.name}`);
        } else {
          console.log(`✓ Content generation already ${existingStatus.status} for subject: ${userSubject.subjects.name}`);
        }
      } catch (error) {
        console.error(`Error creating status for subject ${userSubject.subject_id}:`, error);
      }
    }

    if (createdStatuses.length > 0) {
      console.log(`Content generation setup complete for user ${userId}. Created/updated ${createdStatuses.length} pending task(s).`);
      return {
        success: true,
        message: `Content generation scheduled for ${createdStatuses.length} subject(s)`,
        statuses: createdStatuses
      };
    } else {
      return {
        success: true,
        message: 'All subjects already have content generation in progress or completed'
      };
    }

  } catch (error) {
    console.error('Error in handleProfileUpdate:', error);
    throw error;
  }
}

module.exports = {
  handleUserSignup,
  handleProfileUpdate
};

