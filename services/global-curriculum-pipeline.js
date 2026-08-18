const prisma = require('../lib/prisma');
const { generateChapters, generateTopics, generateTopicGoals } = require('./ai/curriculum');
const { notifyContentGenerationStatus } = require('./notifications');

/**
 * Global Curriculum Pipeline
 * 
 * Generates curriculum (chapters → topics → goals) ONCE per board+grade+subject combination.
 * All users with the same board/grade/subject share the same global catalog.
 * Individual user progress is tracked via user_chapter_progress / user_topic_progress tables.
 */

// In-memory lock to prevent duplicate concurrent generation for the same combo
const generationLocks = new Set();

function getLockKey(board, grade, subjectName) {
	return `${board}::${grade}::${subjectName}`.toLowerCase();
}

// Helper to create prefix logger
function createLogger(board, grade, subjectName) {
	const prefix = `[Global | ${board} ${grade} | ${subjectName}]`;
	return {
		log: (...args) => console.log(prefix, ...args),
		error: (...args) => console.error(prefix, ...args),
		warn: (...args) => console.warn(prefix, ...args)
	};
}

/**
 * Check if global curriculum already exists for this board+grade+subject combo
 */
async function checkGlobalCurriculumStatus(board, grade, subjectName) {
	return await prisma.global_curriculum_status.findUnique({
		where: {
			board_grade_subject_name: {
				board,
				grade,
				subject_name: subjectName,
			},
		},
	});
}

/**
 * Create or update global curriculum generation status
 */
async function updateGlobalStatus(board, grade, subjectName, updates) {
	return await prisma.global_curriculum_status.upsert({
		where: {
			board_grade_subject_name: {
				board,
				grade,
				subject_name: subjectName,
			},
		},
		update: {
			...updates,
			updated_at: new Date(),
		},
		create: {
			board,
			grade,
			subject_name: subjectName,
			...updates,
		},
	});
}

/**
 * Generate global chapters for a subject
 */
async function generateGlobalChapters(globalSubjectId, board, grade, subjectName, logger = console) {
	logger.log(`Generating global chapters...`);

	try {
		// Extract numeric grade for AI prompt (e.g. "Grade 10" → "10")
		const gradeLevel = grade.replace(/\D/g, '') || grade;

		// Call AI to generate chapters (reuses existing AI pipeline with web search)
		const chaptersData = await generateChapters(gradeLevel, board, subjectName);

		// Ensure chapters are numbered correctly
		chaptersData.forEach((chapter, index) => {
			if (!chapter.title.startsWith('Chapter')) {
				chapter.title = `Chapter ${index + 1}: ${chapter.title}`;
			}
		});

		// Store in global_chapters table
		const createdChapters = [];
		for (let i = 0; i < chaptersData.length; i++) {
			const chapterData = chaptersData[i];
			const chapter = await prisma.global_chapters.create({
				data: {
					subject_id: globalSubjectId,
					title: chapterData.title,
					content: chapterData.content,
					order: i + 1,
				},
			});
			createdChapters.push(chapter);
		}

		logger.log(`✓ Created ${createdChapters.length} global chapters for ${subjectName}`);
		return createdChapters;
	} catch (error) {
		logger.error('Error generating global chapters:', error);
		throw error;
	}
}

/**
 * Generate global topics for a specific chapter
 */
async function generateGlobalTopics(globalSubjectId, chapter, board, grade, subjectName, logger = console) {
	logger.log(`Generating topics for Chapter: ${chapter.title}`);

	try {
		const gradeLevel = grade.replace(/\D/g, '') || grade;

		// Call AI to generate topics
		const topicsData = await generateTopics(
			gradeLevel,
			board,
			subjectName,
			chapter.title,
			chapter.content,
		);

		// Format topic titles with proper numbering
		topicsData.forEach((topic, index) => {
			if (!topic.title.startsWith('Topic')) {
				topic.title = `Topic ${index + 1}: ${topic.title}`;
			}
		});

		// Store in global_topics table
		const createdTopics = [];
		for (let i = 0; i < topicsData.length; i++) {
			const topicData = topicsData[i];
			const topic = await prisma.global_topics.create({
				data: {
					chapter_id: chapter.id,
					subject_id: globalSubjectId,
					title: topicData.title,
					content: topicData.content,
					order: i + 1,
				},
			});
			createdTopics.push(topic);
		}

		logger.log(`✓ Created ${createdTopics.length} global topics for chapter: ${chapter.title}`);
		return createdTopics;
	} catch (error) {
		logger.error('✗ Error generating global topics:', error);
		throw error;
	}
}

/**
 * Generate global learning goals for a specific topic
 */
async function generateGlobalGoals(topic, logger = console) {
	logger.log(`  Generating goals for Topic: ${topic.title}`);

	try {
		const goalsData = await generateTopicGoals(topic.title, topic.content);

		let goals = goalsData.goals || [];
		if (goals.length < 4) {
			logger.log(`  ⚠️ Insufficient goals (${goals.length}) for ${topic.title}, retrying...`);
			goals = await regenerateGoalsUntilMinimum(topic);
		}

		// Store in global_topic_goals table
		const createdGoals = [];
		for (let i = 0; i < goals.length; i++) {
			const goalData = goals[i];
			const goal = await prisma.global_topic_goals.create({
				data: {
					topic_id: topic.id,
					title: `Goal ${i + 1}: ${goalData.title}`,
					description: goalData.description,
					order: i + 1,
				},
			});
			createdGoals.push(goal);
		}

		logger.log(`  ✓ Created ${createdGoals.length} global goals for topic: ${topic.title}`);
		return createdGoals;
	} catch (error) {
		logger.error(`  ✗ Error generating global goals for topic ${topic.title}:`, error.message);
		return [];
	}
}

/**
 * Regenerate goals until we have at least N valid goals
 */
async function regenerateGoalsUntilMinimum(topic, minimumGoals = 4) {
	let attempts = 0;
	const maxAttempts = 3;
	let goals = [];

	while (goals.length < minimumGoals && attempts < maxAttempts) {
		const newGoals = await generateTopicGoals(topic.title, topic.content);
		goals = [...new Set([...goals, ...newGoals.goals])];
		attempts++;
	}

	return goals.slice(0, Math.max(minimumGoals, goals.length));
}

/**
 * Main entry point: Ensure global curriculum exists for a board+grade+subject combo.
 * If it already exists, returns the existing global_subject record.
 * If not, generates it via AI pipeline and returns the newly created record.
 * 
 * @param {string} board - e.g. "CBSE"
 * @param {string} grade - e.g. "Grade 10"
 * @param {string} subjectName - e.g. "Mathematics"
 * @param {string} subjectCode - optional code, e.g. "math_10"
 * @param {string} category - optional category
 * @returns {Object} { globalSubject, alreadyExisted }
 */
async function ensureGlobalCurriculum(board, grade, subjectName, subjectCode = null, category = null) {
	const lockKey = getLockKey(board, grade, subjectName);
	const logger = createLogger(board, grade, subjectName);

	// 1. Direct database check: Check if global_subjects already exists and has chapters
	const existingGlobalSubject = await prisma.global_subjects.findUnique({
		where: {
			board_grade_name: {
				board,
				grade,
				name: subjectName,
			},
		},
		include: {
			chapters: {
				select: { id: true },
				take: 1
			}
		}
	});

	if (existingGlobalSubject && existingGlobalSubject.chapters.length > 0) {
		logger.log('Global curriculum already exists in database with chapters, skipping generation.');
		return { globalSubject: existingGlobalSubject, alreadyExisted: true };
	}

	// 2. Check global curriculum status table
	const existingStatus = await checkGlobalCurriculumStatus(board, grade, subjectName);
	if (existingStatus && existingStatus.status === 'completed' && existingStatus.global_subject_id) {
		const globalSubject = await prisma.global_subjects.findUnique({
			where: { id: existingStatus.global_subject_id },
		});
		if (globalSubject) {
			logger.log('Global curriculum already exists (from status), skipping generation.');
			return { globalSubject, alreadyExisted: true };
		}
	}

	// Check if generation is already in progress (in-memory lock)
	if (generationLocks.has(lockKey)) {
		logger.log('Generation already in progress (locked), skipping.');
		return { globalSubject: null, alreadyExisted: false, inProgress: true };
	}

	// Also check DB status for in_progress (allow auto-resume if older than 5 minutes or explicitly restarting)
	if (existingStatus && existingStatus.status === 'in_progress') {
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
		const lastUpdated = existingStatus.updated_at ? new Date(existingStatus.updated_at) : new Date(existingStatus.created_at);
		
		if (lastUpdated > fiveMinutesAgo) {
			logger.log('Generation currently active by another worker, skipping.');
			return { globalSubject: null, alreadyExisted: false, inProgress: true };
		} else {
			logger.log('🔄 Found previous interrupted generation (>5 min ago). Resuming exactly where it stopped...');
		}
	}

	// Acquire lock
	generationLocks.add(lockKey);

	try {
		// Mark as in progress
		await updateGlobalStatus(board, grade, subjectName, {
			status: 'in_progress',
			generation_started_at: new Date(),
		});

		logger.log(`Starting global curriculum generation pipeline...`);

		// Step 0: Create global_subjects record
		const globalSubject = await prisma.global_subjects.upsert({
			where: {
				board_grade_name: {
					board,
					grade,
					name: subjectName,
				},
			},
			update: {
				code: subjectCode,
				category,
				updated_at: new Date(),
			},
			create: {
				board,
				grade,
				name: subjectName,
				code: subjectCode,
				category,
			},
		});

		// Step 1: Generate chapters
		let chapters;
		if (existingStatus && existingStatus.chapters_generated) {
			logger.log('Chapters already generated, retrieving...');
			chapters = await prisma.global_chapters.findMany({
				where: { subject_id: globalSubject.id },
				orderBy: { order: 'asc' },
			});
		} else {
			chapters = await generateGlobalChapters(globalSubject.id, board, grade, subjectName, logger);
			await updateGlobalStatus(board, grade, subjectName, { chapters_generated: true });
		}

		// Step 2: Generate topics for each chapter
		let totalTopicsCount = 0;
		if (existingStatus && existingStatus.topics_generated) {
			logger.log('Topics already generated, retrieving count...');
			totalTopicsCount = await prisma.global_topics.count({
				where: { subject_id: globalSubject.id },
			});
		} else {
			for (const chapter of chapters) {
				const existingTopics = await prisma.global_topics.findMany({
					where: { chapter_id: chapter.id },
				});

				if (existingTopics.length > 0) {
					logger.log(`Topics already exist for chapter: ${chapter.title}, skipping.`);
					totalTopicsCount += existingTopics.length;
					continue;
				}

				const topics = await generateGlobalTopics(globalSubject.id, chapter, board, grade, subjectName, logger);
				totalTopicsCount += topics.length;
			}
			await updateGlobalStatus(board, grade, subjectName, { topics_generated: true });
		}

		// Step 3: Generate goals for all topics
		logger.log(`Generating goals for all ${totalTopicsCount} topics...`);
		let totalGoalsCount = 0;

		for (const chapter of chapters) {
			const chapterTopics = await prisma.global_topics.findMany({
				where: { chapter_id: chapter.id },
			});

			for (const topic of chapterTopics) {
				const existingGoalsCount = await prisma.global_topic_goals.count({
					where: { topic_id: topic.id },
				});

				if (existingGoalsCount >= 4) {
					totalGoalsCount += existingGoalsCount;
					continue;
				}

				const goals = await generateGlobalGoals(topic, logger);
				totalGoalsCount += goals.length;

				// Small delay to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}

		await updateGlobalStatus(board, grade, subjectName, { goals_generated: true });

		// Mark as completed
		await updateGlobalStatus(board, grade, subjectName, {
			status: 'completed',
			global_subject_id: globalSubject.id,
			generation_completed_at: new Date(),
		});

		logger.log(`✓✓✓ Global pipeline completed successfully ✓✓✓`);
		logger.log(`Chapters: ${chapters.length}, Topics: ${totalTopicsCount}, Goals: ${totalGoalsCount}`);

		return { globalSubject, alreadyExisted: false };

	} catch (error) {
		logger.error('Global pipeline error:', error);

		await updateGlobalStatus(board, grade, subjectName, {
			status: 'failed',
			error_message: error.message,
		});

		throw error;
	} finally {
		// Release lock
		generationLocks.delete(lockKey);
	}
}

/**
 * Enroll a user in a global subject.
 * Creates user_subject_enrollment and initializes progress tracking.
 * 
 * @param {number} userId
 * @param {number} globalSubjectId
 */
async function enrollUserInSubject(userId, globalSubjectId) {
	// Create enrollment record
	const enrollment = await prisma.user_subject_enrollment.upsert({
		where: {
			user_id_subject_id: {
				user_id: userId,
				subject_id: globalSubjectId,
			},
		},
		update: {},
		create: {
			user_id: userId,
			subject_id: globalSubjectId,
		},
	});

	// Initialize chapter progress for all chapters in this subject
	const chapters = await prisma.global_chapters.findMany({
		where: { subject_id: globalSubjectId },
		include: {
			topics: {
				select: { id: true },
			},
		},
	});

	for (const chapter of chapters) {
		await prisma.user_chapter_progress.upsert({
			where: {
				user_id_chapter_id: {
					user_id: userId,
					chapter_id: chapter.id,
				},
			},
			update: {},
			create: {
				user_id: userId,
				chapter_id: chapter.id,
				total_topics: chapter.topics.length,
				completed_topics: 0,
				completion_percent: 0,
			},
		});
	}

	console.log(`✓ User ${userId} enrolled in global subject ${globalSubjectId} with ${chapters.length} chapter progress records`);
	return enrollment;
}

/**
 * Generate missing global goals for topics that don't have them yet
 */
async function generateMissingGlobalGoals() {
	console.log('\n=== [global-pipeline] Checking for global topics without goals ===');

	try {
		const topicsWithoutGoals = await prisma.global_topics.findMany({
			where: {
				goals: {
					none: {},
				},
			},
			include: {
				chapter: {
					select: { title: true },
				},
			},
		});

		if (topicsWithoutGoals.length === 0) {
			console.log('All global topics have goals.');
			return { success: true, generated: 0, total: 0 };
		}

		console.log(`Found ${topicsWithoutGoals.length} global topic(s) without goals`);

		let generated = 0;
		let failed = 0;

		for (const topic of topicsWithoutGoals) {
			try {
				console.log(`\nGenerating goals for: ${topic.chapter?.title} > ${topic.title}`);
				const goals = await generateGlobalGoals(topic);

				if (goals.length > 0) {
					generated++;
				} else {
					failed++;
				}

				await new Promise(resolve => setTimeout(resolve, 1000));
			} catch (error) {
				console.error(`✗ Error processing global topic ${topic.id}:`, error.message);
				failed++;
			}
		}

		return { success: true, total: topicsWithoutGoals.length, generated, failed };
	} catch (error) {
		console.error('Error generating missing global goals:', error);
		throw error;
	}
}

/**
 * Process all pending global curriculum generation tasks
 */
async function processGlobalPendingTasks() {
	console.log('\n📚 [global-pipeline] Checking for pending global curriculum tasks...');

	try {
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
		const pendingTasks = await prisma.global_curriculum_status.findMany({
			where: {
				OR: [
					{ status: 'pending' },
					{ status: 'failed', updated_at: { lt: fiveMinutesAgo } },
				],
			},
			orderBy: { created_at: 'asc' },
		});

		if (pendingTasks.length === 0) {
			console.log('📋 No pending global curriculum tasks');
			// Check for missing goals
			await generateMissingGlobalGoals();
			return;
		}

		console.log(`Found ${pendingTasks.length} pending global task(s)`);

		for (const task of pendingTasks) {
			try {
				console.log(`\n🚀 Processing: ${task.board} ${task.grade} ${task.subject_name}`);
				await ensureGlobalCurriculum(task.board, task.grade, task.subject_name);
				console.log(`✅ Completed: ${task.board} ${task.grade} ${task.subject_name}`);

				await new Promise(resolve => setTimeout(resolve, 2000));
			} catch (error) {
				console.error(`❌ Failed: ${task.board} ${task.grade} ${task.subject_name} - ${error.message}`);
			}
		}

		console.log('\n✅ Global processing cycle completed');
	} catch (error) {
		console.error('❌ Error in global processing cycle:', error);
	}
}

module.exports = {
	ensureGlobalCurriculum,
	enrollUserInSubject,
	checkGlobalCurriculumStatus,
	generateMissingGlobalGoals,
	processGlobalPendingTasks,
};
