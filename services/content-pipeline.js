const prisma = require('../lib/prisma');
const { generateChapters, generateTopics, generateTopicGoals } = require('./ai/curriculum');
const { notifyContentGenerationStatus } = require('./notifications');

// Helper to create prefix logger for clean concurrent debugging/logging
function createLogger(userId, subjectName) {
	const prefix = `[User ${userId} | ${subjectName}]`;
	return {
		log: (...args) => console.log(prefix, ...args),
		error: (...args) => console.error(prefix, ...args),
		warn: (...args) => console.warn(prefix, ...args)
	};
}

/**
 * Check if content generation is needed for a user-subject combination
 */
async function checkGenerationStatus(userId, subjectId, gradeLevel, board) {
	const status = await prisma.content_generation_status.findUnique({
		where: {
			user_id_subject_id_grade_level_board: {
				user_id: userId,
				subject_id: subjectId,
				grade_level: gradeLevel,
				board: board,
			},
		},
	});

	return status;
}

/**
 * Create or update generation status
 */
async function updateGenerationStatus(userId, subjectId, gradeLevel, board, updates) {
	return await prisma.content_generation_status.upsert({
		where: {
			user_id_subject_id_grade_level_board: {
				user_id: userId,
				subject_id: subjectId,
				grade_level: gradeLevel,
				board: board,
			},
		},
		update: {
			...updates,
			updated_at: new Date(),
		},
		create: {
			user_id: userId,
			subject_id: subjectId,
			grade_level: gradeLevel,
			board: board,
			...updates,
		},
	});
}

/**
 * Generate chapters for a subject
 */
async function generateChaptersForSubject(userId, subjectId, gradeLevel, board, subjectName, logger = console) {
	logger.log(`Generating chapters for User ${userId}, Subject: ${subjectName}`);

	try {
		// Call AI to generate chapters in proper order
		const chaptersData = await generateChapters(gradeLevel, board, subjectName, userId);

		// Ensure chapters are numbered correctly
		chaptersData.forEach((chapter, index) => {
			if (!chapter.title.startsWith('Chapter')) {
				chapter.title = `Chapter ${index + 1}: ${chapter.title}`;
			}
		});

		// Store chapters in database
		const createdChapters = [];
		for (const chapterData of chaptersData) {
			const chapter = await prisma.chapters.create({
				data: {
					subject_id: subjectId,
					user_id: userId,
					title: chapterData.title,
					content: chapterData.content,
					total_topics: 0,
					completed_topics: 0,
					completion_percent: 0,
				},
			});
			createdChapters.push(chapter);
		}

		logger.log(`Created ${createdChapters.length} chapters for ${subjectName}`);
		return createdChapters;
	} catch (error) {
		logger.error('Error generating chapters:', error);
		throw error;
	}
}

/**
 * Generate topics for a specific chapter
 */
async function generateTopicsForChapter(userId, subjectId, chapter, gradeLevel, board, subjectName, logger = console) {
	logger.log(`Generating topics for Chapter: ${chapter.title}`);

	try {
		// Call AI to generate topics
		const topicsData = await generateTopics(
			gradeLevel,
			board,
			subjectName,
			chapter.title,
			chapter.content,
			userId
		);


		// Format topic titles with proper numbering
		topicsData.forEach((topic, index) => {
			if (!topic.title.startsWith('Topic')) {
				topic.title = `Topic ${index + 1}: ${topic.title}`;
			}
		});

		// Store topics in database
		const createdTopics = [];
		for (const topicData of topicsData) {
			const topic = await prisma.topics.create({
				data: {
					subject_id: subjectId,
					chapter_id: chapter.id,
					user_id: userId,
					title: topicData.title,
					content: topicData.content,
					is_completed: false,
					completion_percent: 0,
				},
			});
			createdTopics.push(topic);
		}

		// Update chapter with total topics
		await prisma.chapters.update({
			where: { id: chapter.id },
			data: {
				total_topics: createdTopics.length,
			},
		});

		logger.log(`✓ Created ${createdTopics.length} topics for chapter: ${chapter.title}`);
		return createdTopics;
	} catch (error) {
		logger.error('✗ Error generating topics:', error);
		throw error;
	}
}

/**
 * Generate learning goals for a specific topic
 */
async function generateGoalsForTopic(topic, logger = console) {
	logger.log(`  Generating goals for Topic: ${topic.title}`);

	try {
		// Generate initial goals
		const goalsData = await generateTopicGoals(topic.title, topic.content, topic.user_id);

		// Ensure we have at least 4 goals
		let goals = goalsData.goals || [];
		if (goals.length < 4) {
			logger.log(`  ⚠️ Insufficient goals (${goals.length}) for ${topic.title}, generating more...`);
			goals = await regenerateGoalsUntilMinimum(topic);
		}

		// Store goals in database
		const createdGoals = [];
		for (let i = 0; i < goals.length; i++) {
			const goalData = goals[i];
			const goal = await prisma.topic_goals.create({
				data: {
					topic_id: topic.id,
					title: `Goal ${i + 1}: ${goalData.title}`,
					description: goalData.description,
					order: i + 1
				}
			});
			createdGoals.push(goal);
		}

		logger.log(`  ✓ Created ${createdGoals.length} goals for topic: ${topic.title}`);
		return createdGoals;
	} catch (error) {
		logger.error(`  ✗ Error generating goals for topic ${topic.title}:`, error.message);
		// Don't throw - allow pipeline to continue even if goal generation fails
		return [];
	}
}

/**
 * Main pipeline: Generate all content for a user's subject
 */
async function runContentGenerationPipeline(userId, subjectId) {
	try {
		// Fetch user and subject details
		const user = await prisma.users.findUnique({
			where: { user_id: userId },
		});

		if (!user) {
			throw new Error(`User ${userId} not found`);
		}

		const subject = await prisma.subjects.findUnique({
			where: { id: subjectId },
		});

		if (!subject) {
			throw new Error(`Subject ${subjectId} not found`);
		}

		const { grade_level, board } = user;

		if (!grade_level || !board) {
			throw new Error('User must have grade_level and board set');
		}

		// Check if generation already completed
		const status = await checkGenerationStatus(userId, subjectId, grade_level, board);

		if (status && status.status === 'completed') {
			console.log('Content already generated for this combination');
			return {
				success: true,
				message: 'Content already exists',
				status,
			};
		}

		if (status && status.status === 'in_progress') {
			console.log('Content generation already in progress');
			return {
				success: false,
				message: 'Generation already in progress',
				status,
			};
		}

		// Mark as in progress
		await updateGenerationStatus(userId, subjectId, grade_level, board, {
			status: 'in_progress',
			generation_started_at: new Date(),
		});

		// Create prefix logger for cleanly tracing logs during concurrent runs
		const logger = createLogger(userId, subject.name);

		logger.log(`Starting content generation pipeline for User: ${userId}, Subject: ${subject.name}`);

		// Step 1: Generate or retrieve chapters
		let chapters;
		if (status && status.chapters_generated) {
			logger.log('Chapters already generated, retrieving from database...');
			chapters = await prisma.chapters.findMany({
				where: {
					subject_id: subjectId,
					user_id: userId
				},
				orderBy: {
					id: 'asc'
				}
			});
		} else {
			chapters = await generateChaptersForSubject(
				userId,
				subjectId,
				grade_level,
				board,
				subject.name,
				logger
			);

			// Update status: chapters generated
			await updateGenerationStatus(userId, subjectId, grade_level, board, {
				chapters_generated: true,
			});
		}

		// Send notification: chapters complete
		await notifyContentGenerationStatus(userId, 'chapters_complete', subject.name, {
			count: chapters.length
		});

		// Step 2: Generate or retrieve topics for each chapter
		let totalTopicsCount = 0;
		if (status && status.topics_generated) {
			logger.log('Topics already generated, retrieving count from database...');
			const topicsCount = await prisma.topics.count({
				where: {
					subject_id: subjectId,
					user_id: userId
				}
			});
			totalTopicsCount = topicsCount;
		} else {
			for (const chapter of chapters) {
				// Check if topics already exist for this chapter
				const existingTopics = await prisma.topics.findMany({
					where: {
						chapter_id: chapter.id,
						user_id: userId
					}
				});

				if (existingTopics.length > 0) {
					logger.log(`Topics already exist for chapter: ${chapter.title}, skipping topic generation for this chapter.`);
					totalTopicsCount += existingTopics.length;
					continue;
				}

				const topics = await generateTopicsForChapter(
					userId,
					subjectId,
					chapter,
					grade_level,
					board,
					subject.name,
					logger
				);
				totalTopicsCount += topics.length;
			}

			// Update status: all topics generated
			await updateGenerationStatus(userId, subjectId, grade_level, board, {
				topics_generated: true,
			});
		}

		// Send notification: topics complete
		await notifyContentGenerationStatus(userId, 'topics_complete', subject.name, {
			count: totalTopicsCount
		});

		// Step 3: Generate goals for all topics
		logger.log(`Generating goals for all ${totalTopicsCount} topics...`);
		let totalGoalsCount = 0;

		for (const chapter of chapters) {
			const chapterTopics = await prisma.topics.findMany({
				where: {
					chapter_id: chapter.id,
					user_id: userId
				}
			});

			logger.log(`Generating goals for ${chapterTopics.length} topics in chapter: ${chapter.title}`);

			for (const topic of chapterTopics) {
				// Check if goals already exist for this topic
				const existingGoalsCount = await prisma.topic_goals.count({
					where: { topic_id: topic.id }
				});

				if (existingGoalsCount >= 4) {
					logger.log(`Goals already exist for topic: ${topic.title}, skipping goal generation.`);
					totalGoalsCount += existingGoalsCount;
					continue;
				}

				const goals = await generateGoalsForTopic(topic, logger);
				totalGoalsCount += goals.length;

				// Small delay to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 500));
			}

			logger.log(`✓ Generated goals for chapter: ${chapter.title}`);
		}

		// Update status: all goals generated
		await updateGenerationStatus(userId, subjectId, grade_level, board, {
			goals_generated: true,
		});

		// Send notification: goals complete
		if (totalGoalsCount > 0) {
			await notifyContentGenerationStatus(userId, 'goals_complete', subject.name, {
				count: totalGoalsCount
			});
		}

		// Update user_subjects table
		await prisma.user_subjects.upsert({
			where: {
				user_id_subject_id: {
					user_id: userId,
					subject_id: subjectId,
				},
			},
			update: {
				total_chapters: chapters.length,
				completed_chapters: 0,
				completion_percent: 0,
			},
			create: {
				user_id: userId,
				subject_id: subjectId,
				total_chapters: chapters.length,
				completed_chapters: 0,
				completion_percent: 0,
			},
		});

		// Mark as completed
		await updateGenerationStatus(userId, subjectId, grade_level, board, {
			status: 'completed',
			generation_completed_at: new Date(),
		});

		logger.log(`✓✓✓ Pipeline completed successfully ✓✓✓`);
		logger.log(`User: ${userId}, Subject: ${subject.name}`);
		logger.log(`Chapters: ${chapters.length}, Topics: ${totalTopicsCount}, Goals: ${totalGoalsCount}`);
		logger.log(`📊 Total API Calls: ${1 + chapters.length + totalTopicsCount} (1 chapters + ${chapters.length} topics + ${totalTopicsCount} goals)`);
		logger.log(`=====================================\n`);

		return {
			success: true,
			message: 'Content generation completed',
			chaptersCount: chapters.length,
			topicsCount: totalTopicsCount,
			goalsCount: totalGoalsCount,
		};
	} catch (error) {
		console.error('Pipeline error:', error);

		// Mark as failed
		const user = await prisma.users.findUnique({ where: { user_id: userId } });
		if (user) {
			await updateGenerationStatus(userId, subjectId, user.grade_level, user.board, {
				status: 'failed',
				error_message: error.message,
			});
		}

		throw error;
	}
}

/**
 * Generate content for all subjects of a user
 */
async function runPipelineForAllUserSubjects(userId) {
	const user = await prisma.users.findUnique({
		where: { user_id: userId },
	});

	if (!user || !user.subjects || user.subjects.length === 0) {
		throw new Error('User has no subjects assigned');
	}

	const results = [];

	for (const subjectCode of user.subjects) {
		try {
			// Find subject by code
			const subject = await prisma.subjects.findUnique({
				where: { code: subjectCode },
			});

			if (!subject) {
				console.log(`Subject with code ${subjectCode} not found, skipping`);
				continue;
			}

			console.log(`\n=== Processing Subject: ${subject.name} ===`);
			const result = await runContentGenerationPipeline(userId, subject.id);
			results.push({
				subject: subject.name,
				...result,
			});

			// Add delay between subjects to avoid rate limiting
			await new Promise(resolve => setTimeout(resolve, 2000));
		} catch (error) {
			console.error(`Error processing subject ${subjectCode}:`, error);
			results.push({
				subject: subjectCode,
				success: false,
				error: error.message,
			});
		}
	}

	return results;
}

/**
 * Regenerate goals until we have at least 4 valid goals
 */
async function regenerateGoalsUntilMinimum(topic, minimumGoals = 4) {
	let attempts = 0;
	const maxAttempts = 3;
	let goals = [];

	while (goals.length < minimumGoals && attempts < maxAttempts) {
		const newGoals = await generateTopicGoals(topic.title, topic.content);
		goals = [...new Set([...goals, ...newGoals.goals])]; // Deduplicate goals
		attempts++;
	}

	return goals.slice(0, Math.max(minimumGoals, goals.length));
}

/**
 * Generate goals for existing topics that don't have goals yet
 */
async function generateMissingGoals() {
	console.log('\n=== [content-pipeline] Checking for topics without goals ===');

	try {
		// Find all topics that don't have any goals or have fewer than 4 goals
		const topicsWithoutGoals = await prisma.topics.findMany({
			where: {
				topic_goals: {
					none: {}
				}
			},
			include: {
				// schema defines relation fields as `chapters` and `subjects`
				chapters: {
					select: {
						title: true
					}
				},
				subjects: {
					select: {
						name: true
					}
				}
			}
		});

		if (topicsWithoutGoals.length === 0) {
			console.log('All topics have goals. Nothing to generate.');
			return { success: true, generated: 0, total: 0 };
		}

		console.log(`Found ${topicsWithoutGoals.length} topic(s) without goals`);

		let generated = 0;
		let failed = 0;

		for (const topic of topicsWithoutGoals) {
			try {
				// Use relation names from schema
				const subjectName = topic.subjects?.name || 'unknown subject';
				const chapterTitle = topic.chapters?.title || 'unknown chapter';
				console.log(`\nGenerating goals for: ${subjectName} > ${chapterTitle} > ${topic.title}`);

				const goals = await generateGoalsForTopic(topic);

				if (goals.length > 0) {
					generated++;
					console.log(`✓ Successfully generated ${goals.length} goals`);
				} else {
					failed++;
					console.log(`✗ Failed to generate goals`);
				}

				// Add delay to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 1000));

			} catch (error) {
				console.error(`✗ Error processing topic ${topic.id}:`, error.message);
				failed++;
			}
		}

		console.log(`\n=== Goal Generation Complete ===`);
		console.log(`Total topics: ${topicsWithoutGoals.length}`);
		console.log(`Generated: ${generated}`);
		console.log(`Failed: ${failed}`);

		return {
			success: true,
			total: topicsWithoutGoals.length,
			generated,
			failed
		};

	} catch (error) {
		console.error('Error generating missing goals:', error);
		throw error;
	}
}

/**
 * Check and process all pending content generation on startup
 */
async function checkAndProcessPendingGenerations() {
	console.log('\n=== Checking for pending content generation ===');

	try {
		// Find all pending or failed content generation tasks
		const pendingTasks = await prisma.content_generation_status.findMany({
			where: {
				OR: [
					{ status: 'pending' },
					{ status: 'failed' }
				]
			},
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

		if (pendingTasks.length === 0) {
			console.log('No pending content generation tasks found.');

			// Check for missing goals in existing topics
			console.log('\n[content-pipeline] Checking for topics without goals...');
			await generateMissingGoals();

			return { processed: 0, total: 0 };
		}

		console.log(`Found ${pendingTasks.length} pending content generation task(s)`);

		let processed = 0;
		let failed = 0;

		for (const task of pendingTasks) {
			try {
				console.log(`\nProcessing: User ${task.user_id}, Subject: ${task.subjects.name}`);

				// Check if user still exists and has complete profile
				const user = await prisma.users.findUnique({
					where: { user_id: task.user_id }
				});

				if (!user) {
					console.log(`User ${task.user_id} not found, skipping...`);
					continue;
				}

				if (!user.grade_level || !user.board) {
					console.log(`User ${task.user_id} profile incomplete, skipping...`);
					continue;
				}

				// Run the content generation pipeline
				await runContentGenerationPipeline(task.user_id, task.subject_id);
				processed++;

				console.log(`✓ Successfully generated content for ${task.subjects.name}`);

				// Add delay between tasks to avoid rate limiting
				await new Promise(resolve => setTimeout(resolve, 2000));

			} catch (error) {
				console.error(`✗ Failed to process task for User ${task.user_id}, Subject ${task.subject_id}:`, error.message);
				failed++;
			}
		}

		console.log(`\n=== Pipeline Check Complete ===`);
		console.log(`Total tasks: ${pendingTasks.length}`);
		console.log(`Processed: ${processed}`);
		console.log(`Failed: ${failed}`);
		console.log(`Skipped: ${pendingTasks.length - processed - failed}`);

		// After processing pending tasks, check for missing goals
		console.log('\n[content-pipeline] Checking for topics without goals...');
		await generateMissingGoals();

		return {
			total: pendingTasks.length,
			processed,
			failed,
			skipped: pendingTasks.length - processed - failed
		};

	} catch (error) {
		console.error('Error checking pending generations:', error);
		throw error;
	}
}

module.exports = {
	checkGenerationStatus,
	runContentGenerationPipeline,
	runPipelineForAllUserSubjects,
	checkAndProcessPendingGenerations,
	generateMissingGoals,
	generateGoalsForTopic,
};

