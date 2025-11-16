const prisma = require('../lib/prisma');
const { createLearningTurn, calculateMasteryScore, getTopicAnalytics } = require('../services/learning_turns_tracker');

/**
 * Test script for learning_turns implementation
 * Run with: node services/test-learning-turns.js
 */

async function testLearningTurns() {
  console.log('\n🧪 Testing Learning Turns Implementation\n');
  console.log('=' .repeat(60));

  try {
    // 1. Test creating a learning turn
    console.log('\n1️⃣ Testing createLearningTurn()...');
    
    // First, get a test user and topic
    const testUser = await prisma.users.findFirst({
      select: { user_id: true, name: true }
    });

    if (!testUser) {
      console.error('❌ No users found in database. Please create a user first.');
      return;
    }

    const testTopic = await prisma.topics.findFirst({
      where: { user_id: testUser.user_id },
      include: {
        topic_goals: true,
        subject_id_rel: {
          select: { id: true, name: true }
        }
      }
    });

    if (!testTopic) {
      console.error('❌ No topics found for this user. Please create a topic first.');
      return;
    }

    const testGoal = testTopic.topic_goals[0];
    if (!testGoal) {
      console.error('❌ No goals found for this topic. Please create goals first.');
      return;
    }

    console.log(`✅ Found test user: ${testUser.name} (ID: ${testUser.user_id})`);
    console.log(`✅ Found test topic: ${testTopic.title} (ID: ${testTopic.id})`);
    console.log(`✅ Found test goal: ${testGoal.title} (ID: ${testGoal.id})`);

    // Create a test learning turn
    const testLearningTurn = await createLearningTurn({
      user_id: testUser.user_id,
      chat_id: 1, // Placeholder
      goal_id: testGoal.id,
      topic_id: testTopic.id,
      subject_id: testTopic.subject_id,
      user_name: testUser.name,
      question_text: 'What is the capital of France?',
      user_answer_raw: 'paris',
      corrected_answer: 'Paris',
      diff_html: '<del>paris</del><ins>Paris</ins>',
      feedback_text: 'Almost correct! Just needs capitalization.',
      feedback_json: {
        is_correct: false,
        bubble_color: 'yellow',
        score_percent: 90,
        error_type: 'Grammar'
      },
      error_type: 'Grammar',
      error_subtype: 'Capitalization',
      is_correct: false,
      score_percent: 90,
      response_time_sec: 15,
      help_requested: null,
      explain_loop_count: 0,
      num_retries: 0,
      goal_progress_before: 0,
      goal_progress_after: 50,
      mastery_score: 45,
      difficulty_level: 'easy',
      topic_title: testTopic.title,
      subject_name: testTopic.subject_id_rel?.name,
      question_type: 'open_ended'
    });

    console.log('✅ Learning turn created successfully!');
    console.log('   ID:', testLearningTurn.id);
    console.log('   Score:', testLearningTurn.score_percent + '%');
    console.log('   Error Type:', testLearningTurn.error_type);

    // 2. Test calculating mastery score
    console.log('\n2️⃣ Testing calculateMasteryScore()...');
    const masteryScore = await calculateMasteryScore(testUser.user_id, testGoal.id);
    console.log(`✅ Mastery Score calculated: ${masteryScore}%`);

    // 3. Test getting topic analytics
    console.log('\n3️⃣ Testing getTopicAnalytics()...');
    const analytics = await getTopicAnalytics(testUser.user_id, testTopic.id);
    console.log('✅ Topic Analytics retrieved:');
    console.log('   Total Questions:', analytics.total_questions);
    console.log('   Correct Answers:', analytics.correct_answers);
    console.log('   Incorrect Answers:', analytics.incorrect_answers);
    console.log('   Average Score:', analytics.average_score + '%');
    console.log('   Error Types:', Object.keys(analytics.error_types).length);

    // 4. Test retrieving learning turns from database
    console.log('\n4️⃣ Testing database retrieval...');
    const allTurns = await prisma.learning_turns.findMany({
      where: {
        user_id: testUser.user_id,
        topic_id: testTopic.id
      },
      orderBy: {
        created_at: 'desc'
      },
      take: 5
    });

    console.log(`✅ Retrieved ${allTurns.length} learning turn(s) from database`);
    allTurns.forEach((turn, index) => {
      console.log(`   ${index + 1}. Question: ${turn.question_text?.substring(0, 50)}...`);
      console.log(`      Correct: ${turn.is_correct}, Score: ${turn.score_percent}%`);
    });

    // 5. Test error type aggregation
    console.log('\n5️⃣ Testing error type aggregation...');
    const errorCounts = await prisma.learning_turns.groupBy({
      by: ['error_type'],
      where: {
        user_id: testUser.user_id,
        is_correct: false,
        error_type: { not: null }
      },
      _count: {
        error_type: true
      }
    });

    console.log('✅ Error type distribution:');
    errorCounts.forEach(error => {
      console.log(`   ${error.error_type}: ${error._count.error_type} occurrence(s)`);
    });

    console.log('\n' + '=' .repeat(60));
    console.log('✅ All tests passed successfully!');
    console.log('\n💡 Next steps:');
    console.log('   1. Test in real chat session by answering questions');
    console.log('   2. Click "Explain" button to test explain_loop_count');
    console.log('   3. Call analytics API endpoints:');
    console.log('      - GET /api/profile/learning-analytics/topic/' + testTopic.id);
    console.log('      - GET /api/profile/learning-analytics/overview');
    console.log('\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testLearningTurns();
