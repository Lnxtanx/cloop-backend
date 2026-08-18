/**
 * Data Migration Script: Per-User Curriculum -> Global Curriculum Catalog
 * 
 * Usage:
 *   node scripts/migrate-to-global-curriculum.js --dry-run
 *   node scripts/migrate-to-global-curriculum.js
 */

const prisma = require('../lib/prisma');

async function migrate() {
	const isDryRun = process.argv.includes('--dry-run');
	console.log(`\n======================================================`);
	console.log(`🚀 Starting Curriculum Globalization Migration ${isDryRun ? '(DRY RUN)' : ''}`);
	console.log(`======================================================\n`);

	try {
		// 1. Fetch all existing users with their board, grade, and subjects
		const users = await prisma.users.findMany({
			select: {
				user_id: true,
				name: true,
				board: true,
				grade_level: true,
				subjects: true,
			}
		});

		console.log(`👥 Found ${users.length} users to inspect.`);

		// 2. Fetch all existing chapters with their topics & goals
		const oldChapters = await prisma.chapters.findMany({
			include: {
				subjects: true,
				users: {
					select: {
						board: true,
						grade_level: true
					}
				},
				topics: {
					include: {
						topic_goals: true
					}
				}
			},
			orderBy: { id: 'asc' }
		});

		console.log(`📚 Found ${oldChapters.length} legacy chapter rows.`);

		// Group legacy chapters by board + grade + subjectName
		const comboMap = new Map();

		for (const ch of oldChapters) {
			const board = ch.users?.board || 'CBSE';
			const grade = ch.users?.grade_level || 'Grade 10';
			const subjectName = ch.subjects?.name || 'Unknown Subject';
			const subjectCode = ch.subjects?.code || null;
			const category = ch.subjects?.category || null;

			const key = `${board}::${grade}::${subjectName}`.toLowerCase();

			if (!comboMap.has(key)) {
				comboMap.set(key, {
					board,
					grade,
					subjectName,
					subjectCode,
					category,
					chapterGroups: []
				});
			}

			comboMap.get(key).chapterGroups.push(ch);
		}

		console.log(`🔍 Identified ${comboMap.size} distinct board+grade+subject combinations.\n`);

		// 3. For each combination, migrate to global catalog
		for (const [key, combo] of comboMap.entries()) {
			console.log(`📦 Processing Combo: ${combo.board} | ${combo.grade} | ${combo.subjectName}`);

			// Select the best/most complete chapter set for this combo
			// Group chapters by normalized title to avoid duplicates
			const uniqueChaptersMap = new Map();

			for (const ch of combo.chapterGroups) {
				const normTitle = ch.title.trim().toLowerCase();
				if (!uniqueChaptersMap.has(normTitle)) {
					uniqueChaptersMap.set(normTitle, {
						title: ch.title,
						content: ch.content,
						topics: ch.topics || []
					});
				} else {
					// If this chapter has more topics, take it
					const existing = uniqueChaptersMap.get(normTitle);
					if ((ch.topics?.length || 0) > (existing.topics?.length || 0)) {
						uniqueChaptersMap.set(normTitle, {
							title: ch.title,
							content: ch.content,
							topics: ch.topics || []
						});
					}
				}
			}

			console.log(`   Found ${uniqueChaptersMap.size} unique global chapters.`);

			if (!isDryRun) {
				// Upsert global_subjects
				const globalSubject = await prisma.global_subjects.upsert({
					where: {
						board_grade_name: {
							board: combo.board,
							grade: combo.grade,
							name: combo.subjectName
						}
					},
					update: {
						code: combo.subjectCode,
						category: combo.category,
						updated_at: new Date()
					},
					create: {
						board: combo.board,
						grade: combo.grade,
						name: combo.subjectName,
						code: combo.subjectCode,
						category: combo.category
					}
				});

				let chapterOrder = 1;
				for (const [_, chData] of uniqueChaptersMap.entries()) {
					// Find or create global_chapter
					let globalChapter = await prisma.global_chapters.findFirst({
						where: {
							subject_id: globalSubject.id,
							title: chData.title
						}
					});

					if (!globalChapter) {
						globalChapter = await prisma.global_chapters.create({
							data: {
								subject_id: globalSubject.id,
								title: chData.title,
								content: chData.content,
								order: chapterOrder++
							}
						});
					}

					let topicOrder = 1;
					for (const topData of chData.topics) {
						let globalTopic = await prisma.global_topics.findFirst({
							where: {
								chapter_id: globalChapter.id,
								title: topData.title
							}
						});

						if (!globalTopic) {
							globalTopic = await prisma.global_topics.create({
								data: {
									chapter_id: globalChapter.id,
									subject_id: globalSubject.id,
									title: topData.title,
									content: topData.content,
									order: topicOrder++
								}
							});
						}

						let goalOrder = 1;
						for (const goalData of (topData.topic_goals || [])) {
							const existingGoal = await prisma.global_topic_goals.findFirst({
								where: {
									topic_id: globalTopic.id,
									title: goalData.title
								}
							});

							if (!existingGoal) {
								await prisma.global_topic_goals.create({
									data: {
										topic_id: globalTopic.id,
										title: goalData.title,
										description: goalData.description,
										order: goalOrder++
									}
								});
							}
						}
					}
				}

				// Mark status completed
				await prisma.global_curriculum_status.upsert({
					where: {
						board_grade_subject_name: {
							board: combo.board,
							grade: combo.grade,
							subject_name: combo.subjectName
						}
					},
					update: {
						global_subject_id: globalSubject.id,
						status: 'completed',
						chapters_generated: true,
						topics_generated: true,
						goals_generated: true,
						generation_completed_at: new Date()
					},
					create: {
						board: combo.board,
						grade: combo.grade,
						subject_name: combo.subjectName,
						global_subject_id: globalSubject.id,
						status: 'completed',
						chapters_generated: true,
						topics_generated: true,
						goals_generated: true,
						generation_completed_at: new Date()
					}
				});

				console.log(`   ✅ Global catalog created/updated for ${combo.subjectName} (ID: ${globalSubject.id})`);
			}
		}

		// 4. Enroll all users into their corresponding global subjects and migrate progress
		console.log(`\n======================================================`);
		console.log(`👤 Enrolling users and migrating progress...`);
		console.log(`======================================================\n`);

		for (const user of users) {
			if (!user.board || !user.grade_level) continue;

			// Find all global subjects matching this user's board & grade
			const matchingGlobalSubjects = await prisma.global_subjects.findMany({
				where: {
					board: user.board,
					grade: user.grade_level
				},
				include: {
					chapters: {
						include: {
							topics: true
						}
					}
				}
			});

			// Filter matching global subjects against user's selected subjects if present
			const selectedSubjectCodes = (user.subjects || []).map(s => s.toLowerCase().trim());
			const filteredSubjects = matchingGlobalSubjects.filter(gs => {
				if (selectedSubjectCodes.length === 0) return true;
				return selectedSubjectCodes.some(code => 
					code === gs.name.toLowerCase() || 
					(gs.code && code === gs.code.toLowerCase()) ||
					gs.name.toLowerCase().includes(code) ||
					code.includes(gs.name.toLowerCase())
				);
			});

			const targetSubjects = filteredSubjects.length > 0 ? filteredSubjects : matchingGlobalSubjects;

			for (const gs of targetSubjects) {
				if (!isDryRun) {
					// Enroll user
					await prisma.user_subject_enrollment.upsert({
						where: {
							user_id_subject_id: {
								user_id: user.user_id,
								subject_id: gs.id
							}
						},
						update: {},
						create: {
							user_id: user.user_id,
							subject_id: gs.id
						}
					});

					// Initialize chapter progress
					for (const ch of gs.chapters) {
						await prisma.user_chapter_progress.upsert({
							where: {
								user_id_chapter_id: {
									user_id: user.user_id,
									chapter_id: ch.id
								}
							},
							update: {
								total_topics: ch.topics.length
							},
							create: {
								user_id: user.user_id,
								chapter_id: ch.id,
								total_topics: ch.topics.length,
								completed_topics: 0,
								completion_percent: 0
							}
						});
					}
				}
			}

			console.log(`   ✓ Processed enrollments for User ${user.user_id} (${user.name})`);
		}

		console.log(`\n======================================================`);
		console.log(`🎉 Migration Completed Successfully!`);
		console.log(`======================================================\n`);

	} catch (error) {
		console.error('\n❌ Migration Failed:', error);
		process.exit(1);
	} finally {
		await prisma.$disconnect();
	}
}

migrate();
