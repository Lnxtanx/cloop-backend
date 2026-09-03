const express = require('express')
const router = express.Router()
const axios = require('axios')
const { authenticateToken } = require('../../middleware/auth')
const { generateTopicChatResponse, generateTopicGreeting, generateTopicGoals } = require('../../services/topic-chat/topic-chat')
const { invokeModel } = require('../../services/ai/deepseek-client')
const { createLearningTurn, incrementExplainCount, calculateMasteryScore } = require('../../services/learning_turns_tracker')
const { searchYouTube, searchImages } = require('../../services/media-search')

const prisma = require('../../lib/prisma')
const { handleTopicChatMessageV2 } = require('./topic-chats-v2')

// Note: Total of 10 questions will be asked across ALL goals (not per goal)
// The AI will intelligently distribute questions across goals

// Helper to normalize text for duplicate detection
function normalizeText(s) {
	if (!s || typeof s !== 'string') return ''
	return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Convert model options (objects or plain strings) into an array of strings for the
 * admin_chat.options String[] column. Objects are JSON-encoded so the value/text pair
 * survives the round trip and can be reparsed on read.
 */
function optionsToStrings(options) {
	if (!Array.isArray(options)) return []
	return options.map(o => {
		if (typeof o === 'string') return o
		if (o && (o.value !== undefined || o.text !== undefined)) {
			return JSON.stringify({ value: String(o.value ?? ''), text: String(o.text ?? o.value ?? '') })
		}
		if (o && typeof o === 'object') {
			const v = o.value ?? o.text
			return v != null ? String(v) : ''
		}
		return String(o ?? '')
	}).filter(Boolean)
}

/**
 * Convert admin_chat.options String[] values back into frontend option objects
 * [{ value, text }]. Plain strings become { value: s, text: s }.
 */
function optionsFromDb(options) {
	if (!Array.isArray(options)) return []
	return options.map(o => {
		if (typeof o !== 'string') {
			// Already an object (e.g. freshly returned in-memory message)
			return typeof o?.value !== 'undefined' || typeof o?.text !== 'undefined'
				? { value: String(o.value ?? ''), text: String(o.text ?? o.value ?? '') }
				: { value: 'x', text: 'x' }
		}
		const trimmed = o.trim()
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				const parsed = JSON.parse(trimmed)
				if (Array.isArray(parsed)) return parsed.map(optionsFromDb)
				if (parsed && (parsed.value !== undefined || parsed.text !== undefined)) {
					return { value: String(parsed.value ?? ''), text: String(parsed.text ?? parsed.value ?? '') }
				}
			} catch (e) { /* fall through */ }
		}
		return trimmed ? { value: trimmed, text: trimmed } : null
	}).flat().filter(Boolean)
}

/**
 * Helper: Find the appropriate goal for linking a message
 * When currentGoal exists, use it. Otherwise, find the last/active goal
 * This prevents orphaned messages when all goals are completed
 */
async function findGoalForLinking(currentGoal, topicGoals, user_id, prisma) {
	// If we have an active goal, use it
	if (currentGoal) {
		return currentGoal
	}

	// If no active goal, find the most recently progressed goal
	// This handles the case when all goals are completed
	if (topicGoals && topicGoals.length > 0) {
		// Find the goal with the most recent chat_goal_progress update
		const goalWithMostProgress = topicGoals.reduce((prev, curr) => {
			const prevTime = prev.chat_goal_progress?.[0]?.updated_at ? new Date(prev.chat_goal_progress[0].updated_at).getTime() : 0
			const currTime = curr.chat_goal_progress?.[0]?.updated_at ? new Date(curr.chat_goal_progress[0].updated_at).getTime() : 0
			return currTime > prevTime ? curr : prev
		})

		if (goalWithMostProgress) {
			return goalWithMostProgress
		}

		// Fallback: use the first goal if no progress info
		return topicGoals[0]
	}

	// If no goals at all (shouldn't happen), return null
	return null
}

// GET /api/topic-chats/reports/recent
// Fetch the 3 most recent detailed topic reports for the user
router.get('/reports/recent', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id;

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required' });
	}

	try {
		const reports = await prisma.user_topic_reports.findMany({
			where: {
				user_id: user_id
			},
			orderBy: {
				updated_at: 'desc'
			},
			take: 3,
			include: {
				topic: {
					select: {
						title: true,
						chapter: {
							select: {
								title: true
							}
						}
					}
				}
			}
		});

		return res.status(200).json(reports);
	} catch (err) {
		console.error('Error fetching recent reports:', err);
		return res.status(500).json({ error: 'Failed to fetch recent reports' });
	}
});
// GET /api/topic-chats/reports/subject/:subjectId
// Fetch all topic reports for a specific subject
router.get('/reports/subject/:subjectId', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id;
	const { subjectId } = req.params;

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required' });
	}

	try {
		const reports = await prisma.user_topic_reports.findMany({
			where: {
				user_id: user_id,
				topic: {
					subject_id: parseInt(subjectId)
				}
			},
			orderBy: {
				updated_at: 'desc'
			},
			include: {
				topic: {
					select: {
						title: true,
						chapter: {
							select: {
								title: true
							}
						}
					}
				}
			}
		});

		return res.status(200).json(reports);
	} catch (err) {
		console.error('Error fetching subject reports:', err);
		return res.status(500).json({ error: 'Failed to fetch subject reports' });
	}
});

// GET /api/topic-chats/:topicId
// Fetch all chat messages for a specific topic
router.get('/:topicId', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { topicId } = req.params
	const query_user_id = req.query.user_id ? parseInt(req.query.user_id) : null

	// Use query user_id if authenticated user matches
	if (query_user_id && query_user_id === user_id) {
		user_id = query_user_id
	}

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!topicId || isNaN(parseInt(topicId))) {
		return res.status(400).json({ error: 'Valid topic ID is required' })
	}

	try {
		// First verify that the topic exists
		const topic = await prisma.global_topics.findUnique({
			where: {
				id: parseInt(topicId)
			},
			include: {
				chapter: {
					select: {
						id: true,
						title: true,
						subject_id: true,
						subject: {
							select: {
								id: true,
								name: true,
								code: true
							}
						}
					}
				},
				user_progress: {
					where: { user_id: user_id },
					select: {
						is_completed: true,
						completion_percent: true,
						time_spent_seconds: true
					}
				}
			}
		})

		if (!topic) {
			return res.status(404).json({ error: 'Topic not found' })
		}

		// Fetch topic goals (we need their ids to find related admin_chat messages)
		const topicGoalsForIds = await prisma.global_topic_goals.findMany({
			where: { topic_id: parseInt(topicId) },
			select: { id: true },
		})

		const topicGoalIds = topicGoalsForIds.map(g => g.id)

		// Get all chat_ids from learning_turns for this topic (fallback lookup)
		const learningTurnsChatIds = await prisma.learning_turns.findMany({
			where: { topic_id: parseInt(topicId), user_id: user_id },
			select: { chat_id: true }
		})
		const chatIdsFromLearningTurns = learningTurnsChatIds.map(t => t.chat_id).filter(Boolean)

		// PRIMARY source: admin_chat — has real timestamps and real IDs for every message
		// We fetch messages in MULTIPLE ways to ensure no messages are missed on refresh:
		// 1. Via chat_goal_progress (linked to goals) — main path
		// 2. Via learning_turns chat_ids (linked directly to topic) — fallback for user messages
		const adminChatMessages = await prisma.admin_chat.findMany({
			where: {
				user_id: user_id,
				OR: [
					// Messages linked via chat_goal_progress to goals (main path)
					{
						chat_goal_progress: {
							some: { goal_id: { in: topicGoalIds } }
						}
					},
					// Messages that have an ID in learning_turns for this topic
					...(chatIdsFromLearningTurns.length > 0 ? [{
						id: { in: chatIdsFromLearningTurns }
					}] : [])
				]
			},
			orderBy: { created_at: 'asc' },
			select: {
				id: true,
				sender: true,
				message: true,
				message_type: true,
				options: true,
				diff_html: true,
				emoji: true,
				images: true,
				videos: true,
				links: true,
				created_at: true
			}
		})

		// ENRICHMENT source: learning_turns — provides diff_html and feedback for user messages
		const learningTurns = await prisma.learning_turns.findMany({
			where: { topic_id: parseInt(topicId), user_id: user_id },
			select: {
				chat_id: true,
				diff_html: true,
				is_correct: true,
				score_percent: true,
				error_type: true,
				corrected_answer: true,
				feedback_text: true,
			}
		})

		// Build lookup map: admin_chat.id → learning_turn enrichment data
		const turnByMessageId = new Map()
		for (const turn of learningTurns) {
			if (turn.chat_id) turnByMessageId.set(turn.chat_id, turn)
		}

		console.log('💬 Admin Chat Messages Found:', adminChatMessages.length)
		console.log('📊 Learning Turns Found:', learningTurns.length)

		// Build final message list from admin_chat, enriching user messages with learning_turn data
		const seenIds = new Set()
		const chatMessages = []

		for (const msg of adminChatMessages) {
			if (seenIds.has(msg.id)) continue
			seenIds.add(msg.id)

			// Unpack serialized media arrays
			const videos = (msg.videos || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			const images = (msg.images || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			const links = (msg.links || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})

			// Check if this is a user message that has correction data
			const turn = turnByMessageId.get(msg.id)
			
			if (msg.sender === 'user') {
				if (turn && (turn.diff_html || turn.is_correct !== undefined)) {
					const emoji = msg.emoji || turn.emoji || (turn.is_correct ? '😊' :
						(turn.score_percent === 0 ? '😓' : turn.score_percent < 50 ? '😢' : '😅'))
					
					chatMessages.push({
						...msg,
						videos,
						images,
						links,
						message_type: 'user_correction', // Force this type for corrected bubbles
						diff_html: turn.diff_html || msg.diff_html || null,
						emoji: emoji,
						feedback: {
							is_correct: turn.is_correct,
							score_percent: turn.score_percent,
							error_type: turn.error_type || null,
						}
					})
				} else {
					// Plain user message
					chatMessages.push({
						...msg,
						videos,
						images,
						links,
						message_type: msg.message_type || 'text'
					})
				}
			} else {
				// AI message — unpack session_metrics if it's a summary
				const enrichedMsg = {
					...msg,
					options: optionsFromDb(msg.options),
					videos,
					images,
					links
				}
				if (msg.message_type === 'session_summary' && msg.diff_html) {
					try {
						if (typeof msg.diff_html === 'string' && msg.diff_html.trim().startsWith('{')) {
							enrichedMsg.session_summary = JSON.parse(msg.diff_html)
						}
					} catch (e) {
						console.error('Failed to parse session summary JSON:', e.message)
					}
				}
				chatMessages.push(enrichedMsg)
			}
		}

		// Already ordered by created_at from Prisma, but re-sort to be safe after enrichment
		chatMessages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

		console.log('✅ Total Chat Messages:', chatMessages.length)

		// Fetch raw chat_process entries for compatibility (if needed by frontend)
		const rawProcesses = await prisma.chat_process.findMany({
			where: {
				admin_chat: {
					chat_goal_progress: {
						some: {
							goal_id: { in: topicGoalIds },
							user_id: user_id
						}
					}
				}
			},
			orderBy: {
				created_at: 'asc'
			},
			select: {
				id: true,
				chat_id: true,
				user_message: true,
				corrected_message: true,
				ai_response: true,
				feedback: true,
				created_at: true,
				updated_at: true
			}
		})

		// Fetch topic goals with progress info
		const topicGoals = await prisma.global_topic_goals.findMany({
			where: {
				topic_id: parseInt(topicId)
			},
			orderBy: {
				order: 'asc'
			},
			include: {
				chat_goal_progress: {
					where: {
						user_id: user_id
					},
					orderBy: {
						created_at: 'desc'
					},
					take: 1
				}
			}
		})

		// If no messages and no goals, generate initial greeting
		let needsGreeting = chatMessages.length === 0
		let initialGreeting = null

		if (needsGreeting) {
			console.log('\n========== CHAT SESSION START ==========');
			console.log('📱 User:', user_id);
			console.log('📚 Topic:', topic.title, '(ID:', topicId, ')');
			console.log('🎯 Goals Count:', topicGoals.length);
			console.log('💬 Existing Messages:', chatMessages.length);
			console.log('\n🎬 Generating initial greeting...');

			// Fetch user profile for board/classLevel context
			const userProfile = await prisma.users.findUnique({
				where: { user_id: user_id },
				select: { board: true, grade_level: true, name: true }
			});

			// Generate greeting with goals context
			const greetingData = await generateTopicGreeting(topic.title, topic.content, topicGoals, userProfile)
			initialGreeting = greetingData.messages

			console.log('\n✅ Greeting Generated and Will Be Sent to Frontend:');
			if (initialGreeting && initialGreeting.length > 0) {
				initialGreeting.forEach((msg, i) => {
					console.log(`  ${i + 1}. [${msg.message_type}]: ${msg.message}`);
				});
			}

			// 🔧 FIX: Store greeting messages in database immediately
			// This ensures the first question is in chat history when user answers
			if (initialGreeting && initialGreeting.length > 0 && topicGoals.length > 0) {
				const firstGoal = topicGoals[0];

				// Store session_frame and hook_prediction data in diff_html as JSON
				const hookPredictionData = greetingData.hook_prediction || null;

				// Store each greeting message in database
				for (let i = 0; i < initialGreeting.length; i++) {
					const msg = initialGreeting[i];
					const messageType = msg.message_type || 'text';

					const chatRecord = await prisma.admin_chat.create({
						data: {
							sender: 'ai',
							message: msg.message,
							message_type: messageType,
							emoji: msg.emoji || null,
							options: optionsToStrings(msg.options),
							diff_html: null,
							users: {
								connect: { user_id: user_id }
							}
						}
					});

					await prisma.chat_goal_progress.upsert({
						where: {
							chat_id_goal_id_user_id: {
								chat_id: chatRecord.id,
								goal_id: firstGoal.id,
								user_id: user_id
							}
						},
						update: {},
						create: {
							chat_id: chatRecord.id,
							goal_id: firstGoal.id,
							user_id: user_id,
							is_completed: false,
							num_questions: 0,
							num_correct: 0
						}
					});
				}

				console.log('✅ Greeting messages stored in database');

				// 🔧 Persist a `session_frame` MARKER row. It is NOT rendered as a card by
				// the frontend — it exists only so determinePhase() sees a 'session_frame'
				// marker and `hasFrame` becomes true (otherwise the phase machine is locked
				// in FRAME forever and never advances to REVEAL/EXPLORE). The card body is
				// intentionally empty; the objectives now live in the Goals bar, and the
				// opening turn stays 2 clean AI bubbles (intro + question).
				try {
					const frameCard = await prisma.admin_chat.create({
						data: {
							user_id,
							sender: 'ai',
							message: '',
							message_type: 'session_frame',
							diff_html: hookPredictionData ? JSON.stringify({ hook_prediction: hookPredictionData }) : null,
							options: [],
							images: [],
							videos: [],
							links: []
						}
					});
					await prisma.chat_goal_progress.upsert({
						where: { chat_id_goal_id_user_id: { chat_id: frameCard.id, goal_id: firstGoal.id, user_id } },
						update: {},
						create: { chat_id: frameCard.id, goal_id: firstGoal.id, user_id, is_completed: false, num_questions: 0, num_correct: 0 }
					});
					console.log('🔖 session_frame marker saved (greeting)');
				} catch (frameErr) {
					console.error('❌ Error saving session_frame marker:', frameErr.message);
				}

				console.log('=========================================\n');
			} else {
				console.log('\n⚠️ NOTE: Greeting NOT stored (no goals exist yet).');
				console.log('⚠️ Create goals first, then greeting will be stored.');
				console.log('=========================================\n');
			}
		}

		// If no goals exist, generate them
		if (topicGoals.length === 0) {
			const goalsData = await generateTopicGoals(topic.title, topic.content)

			// Save generated goals
			for (const goal of goalsData.goals) {
				await prisma.global_topic_goals.create({
					data: {
						topic_id: parseInt(topicId),
						title: goal.title,
						description: goal.description,
						order: goal.order
					}
				})
			}
		}

		// Refetch goals after potential creation
		const updatedGoals = await prisma.global_topic_goals.findMany({
			where: {
				topic_id: parseInt(topicId)
			},
			orderBy: {
				order: 'asc'
			},
			include: {
				chat_goal_progress: {
					where: {
						user_id: user_id
					},
					orderBy: {
						created_at: 'desc'
					},
					take: 1
				}
			}
		})

		// 🔧 FIX: Re-fetch chat messages after storing greeting
		// This ensures greeting messages are included in the response
		if (needsGreeting && initialGreeting && initialGreeting.length > 0) {
			const updatedChatMessages = await prisma.admin_chat.findMany({
				where: {
					chat_goal_progress: {
						some: {
							goal_id: { in: topicGoalIds },
							user_id: user_id
						}
					}
				},
				orderBy: {
					created_at: 'asc'
				},
				select: {
					id: true,
					sender: true,
					message: true,
					message_type: true,
					options: true,
					diff_html: true,
					emoji: true,
					images: true,
					videos: true,
					links: true,
					created_at: true
				}
			});

			// Replace chatMessages with updated list
			chatMessages.length = 0;
			chatMessages.push(...updatedChatMessages);
			console.log('✅ Re-fetched chat messages after storing greeting:', chatMessages.length);
		}

		console.log('\n========== RESPONSE TO FRONTEND ==========');
		console.log('📦 Sending Data:');
		console.log('  - Topic:', topic.title);
		console.log('  - Stored Messages:', chatMessages.length);
		console.log('  - Goals:', updatedGoals.length);
		console.log('\n🎯 Goals Status:');
		updatedGoals.forEach((goal, i) => {
			const progress = goal.chat_goal_progress?.[0];
			const status = progress?.is_completed ? '✅ COMPLETED' : progress ? `⏳ IN PROGRESS (${progress.num_questions} questions)` : '⭕ NOT STARTED';
			console.log(`  ${i + 1}. ${goal.title} - ${status}`);
		});
		console.log('==========================================\n');

		const topicProgress = topic.user_progress?.[0] || {}
		return res.status(200).json({
			topic: {
				id: topic.id,
				title: topic.title,
				content: topic.content,
				is_completed: topicProgress.is_completed || false,
				completion_percent: topicProgress.completion_percent || 0,
				time_spent_seconds: topicProgress.time_spent_seconds || 0,
				chapter: topic.chapter,
				subject: topic.chapter?.subject
			},
			messages: chatMessages.filter(m => m.sender === 'user'),
			aiMessages: chatMessages.filter(m => m.sender === 'ai'),
			rawProcesses: rawProcesses,
			goals: updatedGoals
		})
	} catch (err) {
		console.error('Error fetching topic chat messages:', err)
		return res.status(500).json({ error: 'Server error while fetching chat messages' })
	}
})

// POST /api/topic-chats/:topicId/message
// Send a new message in the topic chat
router.post('/:topicId/message', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { topicId } = req.params
	const { message, file_url, file_type, voice_enabled } = req.body

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!topicId || isNaN(parseInt(topicId))) {
		return res.status(400).json({ error: 'Valid topic ID is required' })
	}

	if (!message && !file_url) {
		return res.status(400).json({ error: 'Message or file is required' })
	}

	// Feature Flag & Kill Switch: Tutor-Core V2 Pipeline
	// Can be disabled globally via ENABLE_TUTOR_CORE_V2=false in .env,
	// or bypassed per-request for debugging/fallback with header 'x-tutor-version': 'v1' or '?v=1'
	const isKillSwitched = process.env.ENABLE_TUTOR_CORE_V2 === 'false' || req.headers['x-tutor-version'] === 'v1' || req.query.v === '1';
	if (!isKillSwitched && (process.env.ENABLE_TUTOR_CORE_V2 === 'true' || process.env.ENABLE_TUTOR_CORE_V2 === undefined)) {
		return handleTopicChatMessageV2(req, res);
	}


	try {
		console.log('\n========== NEW MESSAGE RECEIVED ==========');
		console.log('📱 User:', user_id);
		console.log('📚 Topic ID:', topicId);
		console.log('💬 User Message:', message ? message.substring(0, 100) : 'None');
		console.log('📎 File:', file_url || 'None');

		// Verify topic exists
		const topic = await prisma.global_topics.findUnique({
			where: {
				id: parseInt(topicId)
			},
			include: {
				chapter: {
					select: {
						title: true,
						subject: {
							select: {
								name: true
							}
						}
					}
				}
			}
		})

		if (!topic) {
			return res.status(404).json({ error: 'Topic not found' })
		}

		// Get recent chat history for context (from admin_chat linked via chat_goal_progress)
		// First get goal ids for this topic
		const topicGoalsForHistory = await prisma.global_topic_goals.findMany({
			where: { topic_id: parseInt(topicId) },
			select: { id: true }
		})
		const goalIdsForHistory = topicGoalsForHistory.map(g => g.id)

		const recentMessages = await prisma.admin_chat.findMany({
			where: {
				chat_goal_progress: {
					some: {
						goal_id: { in: goalIdsForHistory },
						user_id: user_id
					}
				}
			},
			orderBy: {
				created_at: 'desc'
			},
			take: 50,
			select: {
				sender: true,
				message: true,
				message_type: true
			}
		})

		// Reverse to get chronological order
		const chatHistory = recentMessages.reverse()

		// Create a placeholder admin_chat record for this user's raw answer.
		// We need an admin_chat row because chat_process.chat_id references admin_chat.
		const userMessage = await prisma.admin_chat.create({
			data: {
				user_id: user_id,
				sender: 'user',
				// Leave the display message empty for now; the AI will populate the corrected version later
				message: null,
				message_type: 'raw',
				diff_html: null,
				options: [],
				images: [],
				videos: [],
				links: []
			},
			select: {
				id: true,
				sender: true,
				message: true,
				message_type: true,
				options: true,
				diff_html: true,
				images: true,
				videos: true,
				links: true,
				created_at: true
			}
		})

		// Fetch topic goals with progress data for context
		const topicGoals = await prisma.global_topic_goals.findMany({
			where: {
				topic_id: parseInt(topicId)
			},
			orderBy: {
				order: 'asc'
			},
			include: {
				chat_goal_progress: {
					where: {
						user_id: user_id
					},
					orderBy: {
						updated_at: 'desc'
					},
					take: 1
				}
			}
		})

		// Find current goal (first incomplete goal)
		let currentGoal = null
		for (const goal of topicGoals) {
			const progress = goal.chat_goal_progress?.[0]
			if (!progress || !progress.is_completed) {
				currentGoal = goal
				break
			}
		}

		console.log(`🎯 Current Active Goal: ${currentGoal ? currentGoal.title : 'All goals completed!'}`)

		console.log('\n📋 Chat History Context (last 10):');
		chatHistory.forEach((msg, i) => {
			console.log(`  ${i + 1}. [${msg.sender}]: ${msg.message ? msg.message.substring(0, 80) : 'empty'}...`);
		});
		console.log('\n🤖 Calling AI to generate response...');

		// 🔧 FIX: ALWAYS link user message to a goal (prevents orphaned messages)
		const linkGoal = await findGoalForLinking(currentGoal, topicGoals, user_id, prisma)
		if (linkGoal) {
			try {
				// Fetch the most recent stats for this goal to carry them forward
				const lastProgress = await prisma.chat_goal_progress.findFirst({
					where: {
						user_id: user_id,
						goal_id: linkGoal.id
					},
					orderBy: { updated_at: 'desc' }
				})

				// Create a NEW link record for this specific user message
				// This ensures the message is visible in GET /api/topic-chats/:topicId
				await prisma.chat_goal_progress.create({
					data: {
						chat_id: userMessage.id,
						goal_id: linkGoal.id,
						user_id: user_id,
						is_completed: lastProgress ? lastProgress.is_completed : false,
						num_questions: lastProgress ? lastProgress.num_questions : 0,
						num_correct: lastProgress ? lastProgress.num_correct : 0,
						num_incorrect: lastProgress ? lastProgress.num_incorrect : 0,
						last_question_id: lastProgress ? lastProgress.last_question_id : null
					}
				})
				const reason = currentGoal ? '' : ' (fallback: all goals complete)'
				console.log(`✅ Created chat_goal_progress link for user message to goal: ${linkGoal.title}${reason}`) 
			} catch (linkErr) {
				console.error('❌ Error linking user message to goal:', linkErr.message)
			}
		} else {
			console.warn('⚠️ No goal found for linking user message - this is unusual')
		}

		// Store the raw user answer in chat_process linked to the placeholder admin_chat
		const newChatProcess = await prisma.chat_process.create({
			data: {
				chat_id: userMessage.id,
				user_message: message || '',
				corrected_message: null,
				ai_response: null,
				wrong_message: null,
				feedback: null,
				images: [],
				videos: [],
				links: []
			}
		})

		// Backend safeguard: if the WHOLE topic has exceeded its ~12-question budget,
		// force predict_score so the session can't grind past the agreed length.
		const topicQuestionsTotal = chatHistory.filter(m => m.sender === 'user').length
		if (topicQuestionsTotal >= 12 && !currentGoal?.chat_goal_progress?.[0]?.is_completed) {
			const nextGoal = topicGoals.find(g => {
				const p = g.chat_goal_progress?.[0]
				return !p || !p.is_completed
			})
			const nextGoalHint = (nextGoal && nextGoal.id !== currentGoal?.id) ? ` Then immediately move to the next goal: "${nextGoal.title}".` : ''
			chatHistory.push({
				sender: 'system',
				message: `OVERRIDE: The topic has already used ${topicQuestionsTotal} questions (budget ${12}). Close the current goal now: return evaluation.next_step_type="predict_score" with a valid score_prediction block.${nextGoalHint} Do NOT ask another question for the current goal.`,
				message_type: 'system'
			})
			console.log(`⚡ FORCE PREDICT_SCORE injected: topic has ${topicQuestionsTotal} questions answered (budget ${12})`)
		}

		// Generate AI response using agentic tutor
		let aiResponse
		try {
			// Fetch user profile for board/classLevel context
			const userProfile = await prisma.users.findUnique({
				where: { user_id: user_id },
				select: { board: true, grade_level: true, name: true }
			});

			aiResponse = await generateTopicChatResponse({
				userMessage: message || 'User shared a file',
				topicTitle: topic.title,
				topicContent: topic.content || 'No additional content provided',
				chatHistory,
				currentGoal,
				topicGoals,
				userId: user_id,
				topicId: parseInt(topicId),
				user: userProfile
			})
		} catch (aiError) {
			console.error('❌ Error generating AI response:', aiError.message)
			console.error('Stack:', aiError.stack)
			
			// Return error response immediately (don't proceed)
			return res.status(500).json({ 
				error: 'Failed to generate AI response',
				details: process.env.NODE_ENV === 'development' ? aiError.message : undefined,
				retryable: true,
				message: 'The AI service encountered an issue. Please try your message again.'
			})
		}

		// ========== LOG AI RESPONSE FOR DEBUGGING ==========
		console.log('\n========== AI RESPONSE DEBUG ==========')
		console.log('📊 aiResponse keys:', Object.keys(aiResponse || {}))
		console.log('📝 mermaid_diagram:', aiResponse?.mermaid_diagram ? 'PRESENT' : 'null/undefined')
		console.log('📝 text_diagram:', aiResponse?.text_diagram ? JSON.stringify(aiResponse.text_diagram) : 'null/undefined')
		console.log('🎬 youtube_video:', aiResponse?.youtube_video ? JSON.stringify(aiResponse.youtube_video) : 'null/undefined')
		console.log('🖼️ google_image:', aiResponse?.google_image ? JSON.stringify(aiResponse.google_image) : 'null/undefined')

		// ========== NORMALIZE BARE "visual" KEY → mermaid_diagram ==========
		// DeepSeek sometimes emits the REVEAL visual under a top-level "visual" key
		// instead of "mermaid_diagram". The saving/rendering pipeline only understands
		// mermaid_diagram/text_diagram/google_image/youtube_video, so map "visual" onto
		// mermaid_diagram when it carries a code block, and also surface any nested
		// mermaid/text diagram the model put inside it. Without this the diagram JSON
		// was emitted but silently dropped — the frontend never rendered it.
		if (aiResponse && aiResponse.visual && !aiResponse.mermaid_diagram) {
			const v = aiResponse.visual;
			const diagramSource = (typeof v === 'object')
				? (v.mermaid_diagram || v.text_diagram || (v.code ? v : null))
				: null;
			if (diagramSource && diagramSource.code) {
				console.log('🌉 Normalizing bare "visual" key → mermaid_diagram');
				aiResponse.mermaid_diagram = {
					code: diagramSource.code,
					title: diagramSource.title || diagramSource.name || (v.title || v.name || 'Diagram'),
					explainer: diagramSource.explainer || v.explainer || '',
					trigger: 'teaching'
				};
			} else if (v && typeof v === 'object' && v.code && !diagramSource) {
				console.log('🌉 Mapping "visual" object with code → mermaid_diagram');
				aiResponse.mermaid_diagram = {
					code: v.code,
					title: v.title || 'Diagram',
					explainer: v.explainer || '',
					trigger: 'teaching'
				};
			}
		}
		// ========== END NORMALIZE ==========
		// ========== SMART INTENT & KEYWORD AUTO-DETECTOR ==========
		// If user requested a video/image/diagram or said "I don't understand", and AI forgot to include media block, auto-populate it!
		const userMsgLower = (message || '').toLowerCase();

		// Clean up AI text if it falsely claimed "I can't share links"
		if (aiResponse && Array.isArray(aiResponse.messages)) {
			aiResponse.messages = aiResponse.messages.map(m => {
				if (m.message && /can'?t share (links|videos|youtube)|cannot (share|provide|show) (links|videos)/i.test(m.message)) {
					return {
						...m,
						message: `Here's a helpful visual explanation for ${topic.title}:`
					};
				}
				return m;
			});
		}

		// 1. Video intent auto-fallback
		if (
			!aiResponse?.youtube_video &&
			(userMsgLower.includes('video') || userMsgLower.includes('youtube') || userMsgLower.includes('watch') || userMsgLower.includes('clip'))
		) {
			console.log('💡 User requested video — auto-generating youtube_video query');
			const query = `${topic.title} ${currentGoal?.title || ''} explanation`.trim();
			aiResponse.youtube_video = {
				search_query: query,
				title: `${topic.title} Explanation`,
				trigger: 'user_request'
			};
		}

		// 2. Image intent auto-fallback
		if (
			!aiResponse?.google_image &&
			(userMsgLower.includes('image') || userMsgLower.includes('picture') || userMsgLower.includes('photo') || userMsgLower.includes('diagram') || userMsgLower.includes('illustration'))
		) {
			console.log('💡 User requested image — auto-generating google_image query');
			const query = `${topic.title} ${currentGoal?.title || ''} diagram`.trim();
			aiResponse.google_image = {
				search_query: query,
				title: `${topic.title} Diagram`,
				trigger: 'user_request'
			};
		}

		// ========== FETCH ACTUAL MEDIA IF AI SUGGESTS IT ==========
		let fetchedVideos = null
		let fetchedImages = null

		// Ground EVERY media query in the actual lesson so results are on-topic and
		// curriculum-relevant — never a generic "education/teaching" video. We do NOT
		// trust the model's free-form search_query alone (it can drift off-topic).

		// ── Stop words that should NEVER appear in search queries ──
		const _STOP_WORDS = new Set([
			'know', 'dont', "don't", 'idk', 'skip', 'sure', 'think', 'sorry',
			'answer', 'question', 'what', 'that', 'this', 'with', 'from', 'about',
			'have', 'will', 'would', 'could', 'should', 'does', 'like', 'just',
			'also', 'very', 'really', 'maybe', 'guess', 'help', 'tell', 'explain',
			'yeah', 'yes', 'no', 'not', 'okay', 'right', 'well', 'hmm', 'umm',
			'the', 'and', 'for', 'are', 'but', 'or', 'an', 'can', 'had', 'has',
			'was', 'were', 'been', 'being', 'do', 'did', 'doing', 'it', 'its',
		])
		// ── Bloom's taxonomy action verbs to strip from goal titles ──
		const _ACTION_VERBS = new Set([
			'identify', 'describe', 'analyze', 'demonstrate', 'compare', 'explain',
			'state', 'calculate', 'evaluate', 'apply', 'define', 'list', 'discuss',
			'classify', 'distinguish', 'illustrate', 'outline', 'summarize', 'write',
			'examine', 'interpret', 'justify', 'predict', 'solve', 'construct',
		])

		const _cleanTopic = String(topic.title || '').replace(/^\s*(topic|chapter)\s*\d+\s*[:\-.]*/i, '').trim()

		// Strip "Goal N:" prefix AND leading action verb from goal title
		const _rawGoal = (currentGoal && currentGoal.title)
			? String(currentGoal.title).replace(/^\s*goal\s*\d+\s*[:\-.]*/i, '').trim() : ''
		const _cleanGoal = _rawGoal.replace(/^\w+\s+/, (match) => {
			return _ACTION_VERBS.has(match.trim().toLowerCase()) ? '' : match
		}).trim()

		// Key term from the correct answer — filter out stop words before picking
		const _answerWords = String(aiResponse?.user_correction?.complete_answer || '')
			.replace(/[\"'.?!,;:]+/g, '').split(/\s+/).filter(Boolean)
			.filter(w => !_STOP_WORDS.has(w.toLowerCase()) && w.length >= 3)
		const _keyTerm = _answerWords.length > 0 ? _answerWords.slice(-2).join(' ') : ''

		// The most specific on-topic anchor available for this turn.
		const _anchor = [_keyTerm, _cleanGoal || _cleanTopic].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || _cleanTopic
		// Constrain a (possibly noisy) model query to the lesson; keep it short.
		const _ground = (q) => {
			q = String(q || '').trim()
			const out = q ? `${q} ${_cleanTopic}` : _anchor
			return out.replace(/\s+/g, ' ').trim().slice(0, 90)
		}
		console.log(`🔍 [query-builder] _cleanTopic="${_cleanTopic}" _cleanGoal="${_cleanGoal}" _keyTerm="${_keyTerm}" _anchor="${_anchor}"`)

		// Fetch YouTube videos if AI suggests one (query grounded in the topic)
		if (aiResponse?.youtube_video?.search_query) {
			try {
				const q = _ground(aiResponse.youtube_video.search_query)
				console.log(`🎬 Fetching YouTube videos for: "${q}"`)
				fetchedVideos = await searchYouTube(q, 2)
				console.log(`✅ YouTube fetch complete: ${fetchedVideos?.length || 0} videos`)
			} catch (mediaErr) {
				console.error('❌ YouTube search failed:', mediaErr.message)
			}
		}

		// Fetch Google images if AI suggests one (query grounded in the topic)
		if (aiResponse?.google_image?.search_query) {
			try {
				const q = _ground(aiResponse.google_image.search_query)
				console.log(`🖼️ Fetching images for: "${q}"`)
				fetchedImages = await searchImages(q, 2)
				console.log(`✅ Image fetch complete: ${fetchedImages?.length || 0} images`)
			} catch (mediaErr) {
				console.error('❌ Image search failed:', mediaErr.message)
			}
		}

		// REVEAL is the concept-introduction turn (emits exam_definition). MEDIA RULES call
		// for a real-world visual here, so attach a topic-grounded image if the model didn't
		// explicitly request one above AND we don't already have images. This is how images
		// (via the Wikimedia fallback) reach the student instead of never appearing.
		if ((aiResponse.exam_definition || aiResponse?.evaluation?.phase === 'REVEAL')
			&& (!fetchedImages || fetchedImages.length === 0)
			&& _anchor) {
			try {
				console.log(`🖼️ [REVEAL] Attaching a topic image for concept intro: "${_anchor}"`)
				fetchedImages = await searchImages(_anchor, 2)
				console.log(`✅ REVEAL image fetch complete: ${fetchedImages?.length || 0} images`)
			} catch (mediaErr) {
				console.error('❌ REVEAL image search failed:', mediaErr.message)
			}
		}

		// ========== SHARE MEDIA WHEN THE STUDENT IS FAILING ==========
		// On a genuine failure (wrong + score < 60), if the model didn't already
		// supply media, fetch a topic-grounded image/diagram + short explainer video
		// so a struggling student always gets an ON-TOPIC visual aid. The query is
		// the clean topic/goal anchor (searchImages/searchYouTube add their own
		// "diagram"/"explained" suffixes — we keep the anchor tight so the specific
		// concept dominates the result).
		// Media is NOT attached on the first wrong answer — only when the student has
		// NOW FAILED 2 TIMES IN A ROW (per MEDIA RULES: video/image after a second
		// failed repair). This stops a video from appearing on every early correction.
		const _fb = aiResponse?.user_correction?.feedback
		const _thisAnswerWrong = _fb && _fb.is_correct === false && (typeof _fb.score_percent !== 'number' || _fb.score_percent < 60)
		// Count consecutive wrong attempts from the student's message history.
		let _consecutiveWrong = _thisAnswerWrong ? 1 : 0
		if (Array.isArray(chatHistory)) {
			for (let i = chatHistory.length - 1; i >= 0; i--) {
				const m = chatHistory[i]
				if (m.sender !== 'user') continue
				if (m.is_correct === false || (m.feedback && m.feedback.is_correct === false)) {
					_consecutiveWrong++
				} else if (m.message_type === 'user_correction' && !(m.feedback?.is_correct)) {
					_consecutiveWrong++
				} else {
					break // hit a correct answer (or a non-answer) — stop counting
				}
			}
		}
		// Only auto-fetch when the model hasn't already provided media, AND the student
		// has just failed twice in a row.
		const _isFailing = _thisAnswerWrong && _consecutiveWrong >= 2
		if (_isFailing && _anchor) {
			try {
				if (!fetchedImages || fetchedImages.length === 0) {
					console.log(`🖼️ [remedial] Fetching image/diagram for a struggling student (${_consecutiveWrong}x): "${_anchor}"`)
					fetchedImages = await searchImages(_anchor, 1)
				}
			} catch (e) { console.error('❌ [remedial] image fetch failed:', e.message) }
			try {
				if (!fetchedVideos || fetchedVideos.length === 0) {
					console.log(`🎬 [remedial] Fetching video for a struggling student (${_consecutiveWrong}x): "${_anchor}"`)
					fetchedVideos = await searchYouTube(_anchor, 1)
				}
			} catch (e) { console.error('❌ [remedial] video fetch failed:', e.message) }
		}

		// Duplicate-question fallback (retry once) — if the model returns a question identical
		// to the last AI question in chatHistory, ask it again with an explicit instruction
		try {
			const lastAi = chatHistory.slice().reverse().find(m => m.sender === 'ai')
			if (aiResponse && Array.isArray(aiResponse.messages) && lastAi) {
				const candidate = aiResponse.messages.find(m => (m.message ?? m.content) && (String(m.message ?? m.content)).includes('?')) || aiResponse.messages[0]
				if (candidate && (candidate.message ?? candidate.content)) {
					const candText = normalizeText(candidate.message ?? candidate.content)
					const lastText = normalizeText(lastAi.message)
					if (candText && lastText && candText === lastText) {
						// Retry once with a firm instruction in the history
						chatHistory.push({ sender: 'system', message: 'Do NOT repeat the previous AI question. Rephrase or ask a different sub-question about the same goal.' })
						try {
							const retryResp = await generateTopicChatResponse({
							userMessage: message || 'User shared a file',
							topicTitle: topic.title,
							topicContent: topic.content || 'No additional content provided',
							chatHistory,
							currentGoal,
							topicGoals
						})
							if (retryResp) aiResponse = retryResp
						} catch (retryErr) {
							console.error('Retry for duplicate question failed:', retryErr)
						}
					}
				}
			}
		} catch (e) {
			console.error('Error during duplicate-question fallback check:', e)
		}

		// Edge case: some model outputs send the correction as an AI message with message_type 'user_correction'
		// instead of as aiResponse.user_correction. Detect that and apply it to the user's placeholder.
		if (!aiResponse.user_correction && Array.isArray(aiResponse.messages)) {
			const idx = aiResponse.messages.findIndex(m => (m.message_type ?? m.type) === 'user_correction' || ((m.message ?? m.content) && /<del>|<ins>/.test(m.message ?? m.content)));
			if (idx !== -1) {
				const correctionMsg = aiResponse.messages.splice(idx, 1)[0];
				// Normalize to user_correction shape
				const inferredUserCorrection = {
					message_type: 'user_correction',
					diff_html: (correctionMsg.message ?? correctionMsg.content) || null,
					complete_answer: correctionMsg.complete_answer || (correctionMsg.message ?? correctionMsg.content) || null,
					options: [],
					feedback: correctionMsg.feedback || { is_correct: false, bubble_color: 'red' }
				};

				// Apply same update logic as when aiResponse.user_correction exists
				try {
					// Update chat_process with AI-corrected details
					await prisma.chat_process.update({
						where: { id: newChatProcess.id },
						data: {
							corrected_message: inferredUserCorrection.complete_answer || null,
							ai_response: (aiResponse.messages && aiResponse.messages.length > 0) ? (aiResponse.messages[0].message || null) : null,
							wrong_message: null,
							feedback: inferredUserCorrection.feedback || null
						}
					})
				} catch (e) {
					console.error('Failed to update chat_process with inferred user correction:', e.message)
				}

				// Update the admin_chat placeholder to contain the corrected user bubble.
				// Keep the user's OWN raw words as the displayed `message` so the transcript
				// always reflects what the student actually typed. The AI's rewritten answer
				// lives in diff_html, shown as an annotation, never as a replacement for the
				// user's text.
				try {
					await prisma.admin_chat.update({
						where: { id: userMessage.id },
						data: {
							diff_html: inferredUserCorrection.diff_html,
							message: message,
							message_type: 'user_correction',
							emoji: inferredUserCorrection.emoji || null,
							options: []
						}
					})
				} catch (e) {
					console.error('Failed to update admin_chat placeholder with inferred correction:', e.message)
				}
			}
		}

		// Handle user_correction: apply correction to user's message and update chat_process
		let userCorrection = null;
		if (aiResponse.user_correction) {
			userCorrection = aiResponse.user_correction;

			// Update chat_process with AI-corrected details
			await prisma.chat_process.update({
				where: { id: newChatProcess.id },
				data: {
					corrected_message: userCorrection.complete_answer || null,
					ai_response: (aiResponse.messages && aiResponse.messages.length > 0) ? (aiResponse.messages[0].message || null) : null,
					wrong_message: null,
					feedback: aiResponse.feedback || null
				}
			})

			// Update the admin_chat placeholder to contain the corrected user bubble. Keep the
			// user's OWN words as `message`; the AI's rewritten answer lives in diff_html.
			await prisma.admin_chat.update({
				where: { id: userMessage.id },
				data: {
					diff_html: userCorrection.diff_html,
					message: message,
					message_type: 'user_correction',
					emoji: userCorrection.emoji || null,
					options: []
				}
			});



			// Refresh the userMessage object to reflect changes (message stays the user's raw text)
			userMessage.diff_html = userCorrection.diff_html;
			userMessage.message = message;
			userMessage.message_type = 'user_correction';
			userMessage.options = [];
			userMessage.emoji = userCorrection.emoji || null;
		} else {
			// No explicit user_correction returned: still update chat_process with AI response if present
			if (aiResponse.feedback || (aiResponse.messages && aiResponse.messages.length > 0)) {
				await prisma.chat_process.update({
					where: { id: newChatProcess.id },
					data: {
						corrected_message: aiResponse.feedback && aiResponse.feedback.corrected_answer ? aiResponse.feedback.corrected_answer : null,
						ai_response: (aiResponse.messages && aiResponse.messages.length > 0) ? (aiResponse.messages[0].message || null) : null,
						feedback: aiResponse.feedback || null
					}
				})
			}

			// Also update the admin_chat placeholder so the user message appears in chat history
			// Use the original user message (from request) as display message when no correction
			try {
				await prisma.admin_chat.update({
					where: { id: userMessage.id },
					data: {
						message: message || userMessage.message || null,
						message_type: 'text',
						diff_html: null,
						options: []
					}
				})

				// Reflect update in returned object
				userMessage.message = message || userMessage.message
				userMessage.message_type = 'text'
				userMessage.diff_html = null
				userMessage.options = []
			} catch (e) {
				console.error('Failed to update admin_chat placeholder for user message:', e)
			}
		}

		// Save AI messages, diagrams, videos, and images in proper order:
		// 1. Feedback/explanation messages (all bubbles except the last one, if multiple)
		// 2. Diagrams/Media (mermaid, text, videos, images)
		// 3. Next question message (the last bubble)
		const aiMessages = [];
		const baseTime = Date.now();
		let timeOffset = 0;

		async function saveAndLinkAiMessage(data) {
			const createdAt = new Date(baseTime + timeOffset);
			timeOffset += 10; // Increment time offset by 10ms to ensure strict ordering

			// Normalize the model's message item shape. DeepSeek may return items as
			// { "message", "message_type" } OR { "type": "text", "content": "..." }.
			const message = data.message ?? data.content ?? '';
			const messageType = data.message_type ?? data.type ?? 'text';

			// Skip persisting an EMPTY plain bubble (the "empty..." artifact). Card/media
			// message types carry their payload in diff_html/videos/etc., so only guard the
			// plain "text" bubble.
			if (!message && messageType === 'text' && !(data.options && data.options.length)) {
				console.warn('[topic-chats] Skipping empty AI text bubble');
				return null;
			}

			const savedMessage = await prisma.admin_chat.create({
				data: {
					user_id: user_id,
					sender: 'ai',
					message: message,
					message_type: messageType,
					options: optionsToStrings(data.options),
					diff_html: data.diff_html || null,
					emoji: data.emoji || null,
					images: (data.images || []).map(x => typeof x === 'string' ? x : (x.url || JSON.stringify(x))),
					videos: (data.videos || []).map(x => typeof x === 'string' ? x : (x.url || JSON.stringify(x))),
					links: (data.links || []).map(x => typeof x === 'string' ? x : (x.url || JSON.stringify(x))),
					created_at: createdAt
				},
				select: {
					id: true,
					sender: true,
					message: true,
					message_type: true,
					options: true,
					diff_html: true,
					emoji: true,
					images: true,
					videos: true,
					links: true,
					created_at: true
				}
			});

			// Unpack serialized media arrays for returned object
			savedMessage.videos = (savedMessage.videos || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			savedMessage.images = (savedMessage.images || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			savedMessage.links = (savedMessage.links || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			savedMessage.options = optionsFromDb(savedMessage.options);

			// Link message to goal
			const linkGoal = await findGoalForLinking(currentGoal, topicGoals, user_id, prisma);
			if (linkGoal) {
				try {
					const existingLink = await prisma.chat_goal_progress.findFirst({
						where: {
							chat_id: savedMessage.id,
							goal_id: linkGoal.id,
							user_id: user_id
						}
					});

					if (!existingLink) {
						const currentStats = await prisma.chat_goal_progress.findFirst({
							where: {
								user_id: user_id,
								goal_id: linkGoal.id
							},
							orderBy: {
								updated_at: 'desc'
							}
						});

						await prisma.chat_goal_progress.create({
							data: {
								chat_id: savedMessage.id,
								goal_id: linkGoal.id,
								user_id: user_id,
								is_completed: currentStats ? currentStats.is_completed : false,
								num_questions: currentStats ? currentStats.num_questions : 0,
								num_correct: currentStats ? currentStats.num_correct : 0,
								num_incorrect: currentStats ? currentStats.num_incorrect : 0
							}
						});
						const reason = currentGoal ? '' : ' (fallback: all goals complete)';
						console.log(`✅ AI message (${data.message_type || 'text'}) linked to goal: ${linkGoal.title}${reason}`);
					}
				} catch (linkErr) {
					console.error(`Error linking AI message (${data.message_type || 'text'}) to goal:`, linkErr.message);
				}
			}

			return savedMessage;
		}

		// Split AI messages into feedback/explanations and next question
		const rawMessages = aiResponse.messages || [];
		const totalMsgs = rawMessages.length;
		let feedbackMsgs = [];
		let questionMsg = null;

		if (totalMsgs > 1) {
			feedbackMsgs = rawMessages.slice(0, totalMsgs - 1);
			questionMsg = rawMessages[totalMsgs - 1];
		} else if (totalMsgs === 1) {
			questionMsg = rawMessages[0];
		}

		// 1. Save feedback messages first
		for (const msg of feedbackMsgs) {
			const saved = await saveAndLinkAiMessage({
				message: msg.message,
				message_type: msg.message_type,
				options: msg.options,
				emoji: msg.emoji,
				images: msg.images,
				videos: msg.videos,
				links: msg.links
			});
			if (saved) aiMessages.push(saved);
		}

		// 2. Save diagrams and media
		// 📊 Save mermaid diagram if present
		if (aiResponse.mermaid_diagram && aiResponse.mermaid_diagram.code) {
			try {
				const diagram = aiResponse.mermaid_diagram;
				const saved = await saveAndLinkAiMessage({
					message: diagram.title || 'Diagram',
					message_type: 'mermaid_diagram',
					diff_html: JSON.stringify({ code: diagram.code, trigger: diagram.trigger || 'teaching' })
				});
				aiMessages.push(saved);
				console.log(`📊 Mermaid diagram saved | Title: ${diagram.title} | Trigger: ${diagram.trigger}`);
			} catch (diagramErr) {
				console.error('❌ Error saving mermaid diagram:', diagramErr.message);
			}
		}

		// 📝 Save text diagram if present
		if (aiResponse.text_diagram && aiResponse.text_diagram.code) {
			try {
				const textDiagram = aiResponse.text_diagram;
				const saved = await saveAndLinkAiMessage({
					message: textDiagram.title || 'Quick Reference',
					message_type: 'text_diagram',
					diff_html: JSON.stringify({ 
						code: textDiagram.code, 
						diagram_type: textDiagram.diagram_type || 'ascii',
						trigger: textDiagram.trigger || 'teaching' 
					})
				});
				aiMessages.push(saved);
				console.log(`📝 Text diagram saved | Title: ${textDiagram.title} | Type: ${textDiagram.diagram_type}`);
			} catch (textDiagramErr) {
				console.error('❌ Error saving text diagram:', textDiagramErr.message);
			}
		}

		// 🎬 Save YouTube videos if present
		if (fetchedVideos && fetchedVideos.length > 0) {
			try {
				for (const video of fetchedVideos) {
					const saved = await saveAndLinkAiMessage({
						message: video.title || 'YouTube Video',
						message_type: 'youtube_video',
						diff_html: JSON.stringify({
							video_id: video.id,
							thumbnail: video.thumbnail,
							url: video.url,
							embedUrl: video.embedUrl,
							channel: video.channel,
							duration: video.duration,
							viewCount: video.viewCount,
							trigger: aiResponse?.youtube_video?.trigger || 'user_request',
							search_query: aiResponse?.youtube_video?.search_query || ''
						}),
						emoji: '🎬',
						videos: [video],
						links: [{ url: video.url, title: video.title }]
					});
					aiMessages.push(saved);
				}
				console.log(`🎬 ${fetchedVideos.length} YouTube videos saved to database`);
			} catch (videoErr) {
				console.error('❌ Error saving YouTube videos:', videoErr.message);
			}
		}

		// 🖼️ Save images if present
		if (fetchedImages && fetchedImages.length > 0) {
			try {
				for (const image of fetchedImages) {
					const saved = await saveAndLinkAiMessage({
						message: image.title || 'Educational Image',
						message_type: 'google_image',
						diff_html: JSON.stringify({
							image_id: image.id,
							thumbnail: image.thumbnail,
							url: image.url,
							source: image.source,
							sourceUrl: image.sourceUrl,
							trigger: aiResponse?.google_image?.trigger || 'user_request',
							search_query: aiResponse?.google_image?.search_query || ''
						}),
						emoji: '🖼️',
						images: [{ url: image.url, thumbnail: image.thumbnail, title: image.title }],
						links: [{ url: image.url, title: image.title }]
					});
					aiMessages.push(saved);
				}
				console.log(`🖼️ ${fetchedImages.length} images saved to database`);
			} catch (imageErr) {
				console.error('❌ Error saving images:', imageErr.message);
			}
		}

		// 3. Save the next question message last
		if (questionMsg) {
			const saved = await saveAndLinkAiMessage({
				message: questionMsg.message,
				message_type: questionMsg.message_type,
				options: questionMsg.options,
				emoji: questionMsg.emoji,
				images: questionMsg.images,
				videos: questionMsg.videos,
				links: questionMsg.links
			});
			if (saved) aiMessages.push(saved);
		}

		// ===== TEACHING ARC: Persist phase-specific rich blocks as card messages =====
		// Each phase emits a top-level block (exam_definition, concept_card,
		// revision_sheet, session_frame). We store each as an admin_chat message so
		// the frontend renders it as a card and reloads it from history.
		async function savePhaseBlock(messageType, data, fallbackMessage) {
			if (!data) return null;
			try {
				// One teaching arc per TOPIC: each phase-block card (session_frame,
				// exam_definition, concept_card, revision_sheet) appears AT MOST ONCE per
				// topic, so session-wide dedup is correct and prevents on-screen duplicates.
				// Per-goal exam definitions arrive INLINE as text bubbles during EXPLORE and
				// are intentionally never re-emitted as a card (i.e. no second exam_definition).
				const alreadySaved = (chatHistory || []).some(m => m.message_type === messageType);
				if (alreadySaved) {
					// Already persisted in this topic's history — do NOT create a duplicate
					// or append a second card: it's already on screen. (Returning a pseudo-
					// object in aiMessages would make the frontend double-render the card.)
					console.log(`🔖 ${messageType} card already exists (skipped duplicate)`);
					return null;
				}
				const saved = await saveAndLinkAiMessage({
					message: fallbackMessage || '',
					message_type: messageType,
					diff_html: JSON.stringify(data),
					options: []
				});
				// Attach the parsed data so the frontend response carries it directly
				const enriched = { ...saved, [messageType]: data };
				aiMessages.push(enriched);
				console.log(`🔖 ${messageType} card saved (${messageType.replace(/_/g, ' ')})`);
				return enriched;
			} catch (blockErr) {
				console.error(`❌ Error saving ${messageType} block:`, blockErr.message);
				return null;
			}
		}

		// Attach from aiResponse (may be in the parsed response of the live call)
		const phaseBlocks = [
			['session_frame', aiResponse.session_frame, ''],
			['hook_prediction', aiResponse.hook_prediction, ''],
			['exam_definition', aiResponse.exam_definition, ''],
			['concept_card', aiResponse.concept_card, ''],
			['revision_sheet', aiResponse.revision_sheet, '']
		];
		for (const [type, data] of phaseBlocks) {
			if (data) {
				await savePhaseBlock(type, data, '');
			}
		}

		// Update goal progress if user_correction feedback is provided
		let completedGoalsCount = 0 // Track for session end detection
		let totalGoalsCount = topicGoals.length // Track total goals
		let justCompletedGoal = null // Captured when AI signals predict_score
		let scorePrediction = null // Computed after goal progress update
		let aiSignalsGoalComplete = false // Hoisted so auto-continue block can access it
		if (userCorrection && userCorrection.feedback && currentGoal) {
			// Update chat_process with feedback
			await prisma.chat_process.update({
				where: { id: newChatProcess.id },
				data: {
					feedback: userCorrection.feedback,
					corrected_message: userCorrection.complete_answer || null
				}
			})

			// Fetch or find existing progress for this goal
			const existingProgress = await prisma.chat_goal_progress.findFirst({
				where: {
					user_id: user_id,
					goal_id: currentGoal.id
				},
				orderBy: {
					updated_at: 'desc'
				}
			})

			// ALL answers count as questions, including "I don't know" (No Answer Provided)
			// This ensures goal progression isn't blocked when students don't know the answer
			const isActualAnswer = true // Always count as a question
			const isCorrectAnswer = !!(userCorrection.feedback.is_correct && (userCorrection.feedback.score_percent || 0) >= 50)

			// 📊 CREATE LEARNING TURN RECORD - Store comprehensive analytics
			try {
				// Extract the last question asked from chat history
				const lastAIQuestion = chatHistory
					.slice()
					.reverse()
					.find(m => m.sender === 'ai' && m.message_type === 'text' && m.message && m.message.includes('?'));
				const questionText = lastAIQuestion ? lastAIQuestion.message : null;

				// Calculate response time (seconds since last AI message)
				let responseTimeSec = 0;
				if (lastAIQuestion && lastAIQuestion.created_at) {
					const aiTime = new Date(lastAIQuestion.created_at).getTime();
					const userTime = new Date().getTime();
					responseTimeSec = Math.max(0, Math.round((userTime - aiTime) / 1000));
				}

				// Calculate mastery score based on recent performance
				const masteryScore = await calculateMasteryScore(user_id, currentGoal.id);

				// Calculate progress percentages
				const progressBefore = existingProgress && existingProgress.num_questions > 0
					? Math.round((existingProgress.num_correct / existingProgress.num_questions) * 100)
					: 0;
				const newNumQuestions = (existingProgress?.num_questions || 0) + (isActualAnswer ? 1 : 0);
				const newNumCorrect = (existingProgress?.num_correct || 0) + (isCorrectAnswer ? 1 : 0);
				const progressAfter = newNumQuestions > 0
					? Math.round((newNumCorrect / newNumQuestions) * 100)
					: 0;

				// Get user name
				const user = await prisma.users.findUnique({
					where: { user_id: user_id },
					select: { name: true }
				});

				// Extract phase info from AI evaluation block
				const aiEvaluation = aiResponse.evaluation || {};
				const questionMode = aiEvaluation.question_mode || 'concept';
				const conceptClarityScore = aiEvaluation.concept_clarity_score !== undefined ? aiEvaluation.concept_clarity_score : null;

				// Create learning turn record
				await createLearningTurn({
					user_id: user_id,
					chat_id: userMessage.id,
					goal_id: currentGoal.id,
					topic_id: parseInt(topicId),
					subject_id: topic.subject_id,
					user_name: user?.name || null,
					question_text: questionText,
					user_answer_raw: message || '',
					corrected_answer: userCorrection.complete_answer || null,
					diff_html: userCorrection.diff_html || null,
					feedback_text: userCorrection.complete_answer || null,
					feedback_json: userCorrection.feedback,
					error_type: userCorrection.feedback.error_type || null,
					error_subtype: null,
					is_correct: isCorrectAnswer,
					score_percent: userCorrection.feedback.score_percent || (isCorrectAnswer ? 100 : 0),
					response_time_sec: responseTimeSec,
					help_requested: null,
					explain_loop_count: 0,
					num_retries: 0,
					goal_progress_before: progressBefore,
					goal_progress_after: progressAfter,
					mastery_score: masteryScore,
					difficulty_level: 'medium',
					topic_title: topic.title,
					subject_name: topic.chapter?.subject?.name || null,
					question_type: questionMode // 'concept' or 'exam'
				});

				console.log('✅ Learning turn record created successfully');
			} catch (learningTurnError) {
				console.error('❌ Failed to create learning turn record:', learningTurnError);
				// Don't fail the request if learning turn creation fails
			}

			// Phase-based goal completion: goal is complete when AI signals next_step_type = 'predict_score'
			// This replaces the old hardcoded "2 questions per goal" rule.
			//
			// 🔧 DETERMINISTIC BACKSTOP: goals must ALWAYS advance so the conversation can't
			// stall. One teaching arc per TOPIC — EXPLORE walks the goals and the whole topic
			// is capped at a HARD budget (~12 questions) regardless of goal count. Each goal
			// completes when the AI signals predict_score OR emits the concept_card; as a
			// safety net, if the topic-wide budget is spent we force-complete the remaining
			// goals rather than let a session grind on.
			const TOPIC_QUESTION_BUDGET = 12
			aiSignalsGoalComplete = aiResponse.evaluation?.next_step_type === 'predict_score'
			const aiClosedGoal = !!aiResponse.concept_card // LOCK's final deliverable (optional accelerator)
			// Topic-wide budget (whole topic, all goals combined): count user messages as
			// questions answered this session. This is in scope and avoids relying on any
			// fresh goal fetch / temporal-dead-zone ordering.
			const topicQuestionsAnswered = chatHistory.filter(m => m.sender === 'user').length
			const budgetExhausted = topicQuestionsAnswered >= TOPIC_QUESTION_BUDGET
			const backstopComplete = aiClosedGoal || budgetExhausted
			aiSignalsGoalComplete = aiSignalsGoalComplete || backstopComplete
			if (aiSignalsGoalComplete) {
				// close the current goal the student just answered
				justCompletedGoal = currentGoal
				// Under ONE-arc-per-topic, LOCK's concept_card OR the hard budget means the
				// whole topic is done → close EVERY remaining goal so the session reliably
				// reaches WRAP instead of grinding/stalling on later goals.
				if (backstopComplete) {
					try {
						await prisma.chat_goal_progress.updateMany({
							where: {
								user_id,
								goal_id: { in: (topicGoals || []).map(g => g.id) },
								is_completed: false
							},
							data: { is_completed: true, updated_at: new Date() }
						})
						console.log(`🔒 Backstop: completed ALL remaining goals for topic (budget/concept_card)`)
					} catch (bulkErr) {
						console.error('⚠️ Backstop bulk-complete failed:', bulkErr.message)
					}
				}
			}

			// 🔧 FIX: Update the progress record specifically for THIS user message
			// We already created it above in the message receiving block, now we update it with the feedback results
			const newNumQuestions = (existingProgress?.num_questions || 0) + (isActualAnswer ? 1 : 0)
			const newNumCorrect = (existingProgress?.num_correct || 0) + (isCorrectAnswer ? 1 : 0)
			const newNumIncorrect = (existingProgress?.num_incorrect || 0) + (isActualAnswer && !isCorrectAnswer ? 1 : 0)
			const shouldComplete = aiSignalsGoalComplete || (existingProgress?.is_completed || false)

			await prisma.chat_goal_progress.update({
				where: {
					chat_id_goal_id_user_id: {
						chat_id: userMessage.id,
						goal_id: currentGoal.id,
						user_id: user_id
					}
				},
				data: {
					num_questions: newNumQuestions,
					num_correct: newNumCorrect,
					num_incorrect: newNumIncorrect,
					is_completed: shouldComplete,
					last_question_id: newChatProcess.id,
					updated_at: new Date()
				}
			})

			const accuracyPercent = newNumQuestions > 0 ? Math.round((newNumCorrect / newNumQuestions) * 100) : 0
			console.log(`📊 Goal Progress Updated for Message ${userMessage.id} | Goal: ${currentGoal.title} | Questions: ${newNumQuestions} | Correct: ${newNumCorrect} | Accuracy: ${accuracyPercent}% | Completed: ${shouldComplete} | AI Signal: ${aiSignalsGoalComplete}`)

			// Update topic completion based on completed goals
			const completedGoals = await prisma.chat_goal_progress.findMany({
				where: {
					user_id: user_id,
					goal_id: {
						in: topicGoals.map(g => g.id)
					},
					is_completed: true
				},
				distinct: ['goal_id']
			})

			completedGoalsCount = completedGoals.length
			const completionPercent = totalGoalsCount > 0
				? Math.round((completedGoalsCount / totalGoalsCount) * 100)
				: 0

			await prisma.user_topic_progress.upsert({
				where: {
					user_id_topic_id: {
						user_id: user_id,
						topic_id: parseInt(topicId)
					}
				},
				update: {
					completion_percent: completionPercent,
					is_completed: completionPercent >= 100,
					last_accessed_at: new Date()
				},
				create: {
					user_id: user_id,
					topic_id: parseInt(topicId),
					completion_percent: completionPercent,
					is_completed: completionPercent >= 100,
					last_accessed_at: new Date()
				}
			})

			console.log(`🎯 Topic Progress | Completed Goals: ${completedGoalsCount}/${totalGoalsCount} | Completion: ${completionPercent}%`)

			// 🔧 FIX: Re-fetch goals with UPDATED progress so subsequent AI calls see correct completion status
			const updatedGoalsAfterProgress = await prisma.global_topic_goals.findMany({
				where: {
					topic_id: parseInt(topicId)
				},
				orderBy: {
					order: 'asc'
				},
				include: {
					chat_goal_progress: {
						where: {
							user_id: user_id
						},
						orderBy: {
							updated_at: 'desc'
						},
						take: 1
					}
				}
			})

			// Replace topicGoals with updated data so AI sees correct state
			topicGoals.length = 0
			topicGoals.push(...updatedGoalsAfterProgress)

			// Re-determine currentGoal with updated completion status
			currentGoal = null
			for (const goal of topicGoals) {
				const progress = goal.chat_goal_progress?.[0]
				if (!progress || !progress.is_completed) {
					currentGoal = goal
					break
				}
			}

			console.log(`🎯 Updated Active Goal: ${currentGoal ? currentGoal.title : 'All goals completed!'}`)

			// Compute score_prediction when AI signals goal completion (reliable DB-based fallback)
			if (aiSignalsGoalComplete && justCompletedGoal) {
				const aiSp = aiResponse.score_prediction
				const updatedGoalData = updatedGoalsAfterProgress.find(g => g.id === justCompletedGoal.id)
				const progressData = updatedGoalData?.chat_goal_progress?.[0]
				const totalQ = progressData?.num_questions || 0
				const totalC = progressData?.num_correct || 0
				const accuracy = totalQ > 0 ? totalC / totalQ : 0
				scorePrediction = {
					goal_id: justCompletedGoal.id,
					goal_title: justCompletedGoal.title,
					concept_score: aiSp?.concept_score ?? accuracy,
					exam_score: aiSp?.exam_score ?? accuracy,
					predicted_score: aiSp?.predicted_score ?? Math.round(accuracy * 100),
				}
				console.log(`🏆 Score Prediction | Goal: ${justCompletedGoal.title} | Predicted: ${scorePrediction.predicted_score}%`)
			}

			// 🔥 SESSION SUMMARY LOGIC: Only generate if ALL goals complete
			if (completedGoalsCount >= totalGoalsCount && !currentGoal) {
				console.log('\n🎉 ALL GOALS COMPLETED! Generating session summary...\n')

				// 🎓 TOPIC COMPLETION GREETING: greet the user once, before the revision card.
				// Persist it as an admin_chat row and surface it in the response so the student
				// sees a clear "you finished this topic" moment, not just a silent card drop.
				try {
					const greetingMsg = `🎉 You've completed ${topic.title}! Here's your revision card — your one-stop summary to revise everything you just learned. Great work!`;
					const savedGreeting = await prisma.admin_chat.create({
						data: {
							user_id: user_id,
							sender: 'ai',
							message: greetingMsg,
							message_type: 'text',
							emoji: '🎉',
							images: [],
							videos: [],
							links: [],
							options: []
						},
						select: {
							id: true, sender: true, message: true, message_type: true,
							options: true, diff_html: true, emoji: true,
							images: true, videos: true, links: true, created_at: true
						}
					})
					aiMessages.push(savedGreeting)
					console.log('🎉 Topic completion greeting saved')
				} catch (greetingErr) {
					console.error('⚠️ Failed to save topic completion greeting:', greetingErr.message)
				}

				try {
					// Generate session summary with updated goals
					const summaryResponse = await generateTopicChatResponse({
						userMessage: '__SESSION_COMPLETE__', // Sentinel triggers a hard WRAP/revision_sheet directive
						topicTitle: topic.title,
						topicContent: topic.content || 'No additional content provided',
						chatHistory,
						currentGoal: null, // No current goal - all complete
						topicGoals: updatedGoalsAfterProgress,
						userId: user_id,
						topicId: parseInt(topicId)
					})

					if (summaryResponse && summaryResponse.messages) {
						for (const summaryMsg of summaryResponse.messages) {
							const metricsData = summaryMsg.session_metrics || summaryResponse.session_metrics;
							// Ensure top-level session_summary is populated for the response
							if (metricsData && !aiResponse.session_summary) {
								aiResponse.session_summary = metricsData;
							}

							// Save to user_topic_reports ONLY if this specific message is the summary
							// OR if we haven't saved it yet (simple flag or message type check)
							if (metricsData && summaryMsg.message_type === 'session_summary') {
								try {
									await prisma.user_topic_reports.upsert({
										where: {
											user_id_topic_id: {
												user_id: user_id,
												topic_id: parseInt(topicId)
											}
										},
										update: {
											total_questions: metricsData.total_questions || 0,
											correct_answers: metricsData.correct_answers || 0,
											incorrect_answers: metricsData.incorrect_answers || 0,
											score_percent: metricsData.overall_score_percent || 0,
											star_rating: metricsData.star_rating || 0,
											performance_level: metricsData.performance_level || 'Unknown',
											metrics_json: metricsData,
											updated_at: new Date()
										},
										create: {
											user_id: user_id,
											topic_id: parseInt(topicId),
											total_questions: metricsData.total_questions || 0,
											correct_answers: metricsData.correct_answers || 0,
											incorrect_answers: metricsData.incorrect_answers || 0,
											score_percent: metricsData.overall_score_percent || 0,
											star_rating: metricsData.star_rating || 0,
											performance_level: metricsData.performance_level || 'Unknown',
											metrics_json: metricsData
										}
									});
									console.log('✅ Saved user_topic_report to database');
								} catch (reportErr) {
									console.error('❌ Failed to save user_topic_report:', reportErr);
								}
							}

							// Save to admin_chat (Persistent)
							const savedSummaryMsg = await prisma.admin_chat.create({
								data: {
									user_id: user_id,
									sender: 'ai',
									message: summaryMsg.formatted_summary || summaryMsg.message || 'Session Summary',
									message_type: 'session_summary',
									options: summaryMsg.options || ['End Session', 'Learn More'],
									diff_html: JSON.stringify(metricsData || {}),
									emoji: summaryMsg.emoji || '🎉',
									images: summaryMsg.images || [],
									videos: summaryMsg.videos || [],
									links: summaryMsg.links || []
								}
							});

							// Link session_summary to the last completed goal so GET history finds it
							const lastCompletedGoal = updatedGoalsAfterProgress.slice().reverse().find(g => g.chat_goal_progress?.[0]?.is_completed)
							if (lastCompletedGoal) {
								try {
									await prisma.chat_goal_progress.create({
										data: {
											chat_id: savedSummaryMsg.id,
											goal_id: lastCompletedGoal.id,
											user_id: user_id,
											is_completed: true,
											num_questions: lastCompletedGoal.chat_goal_progress?.[0]?.num_questions || 0,
											num_correct: lastCompletedGoal.chat_goal_progress?.[0]?.num_correct || 0,
											num_incorrect: lastCompletedGoal.chat_goal_progress?.[0]?.num_incorrect || 0,
										}
									})
								} catch (_) {} // ignore if duplicate
							}

							// Add to aiMessages for frontend response
							aiMessages.push({
								...savedSummaryMsg,
								session_summary: metricsData // Ensure frontend gets the object
							});
						}
					}

					// GUARANTEED revision_sheet: if the model failed to emit a revision_sheet
					// (or the whole summary generation errored), synthesize one from session
					// analytics so the end-of-session card ALWAYS renders.
					const { calculateSessionMetrics } = require('../../services/topic-chat/topic_chat_metrics');
					let hadRevisionSheet = aiMessages.some(m => m.message_type === 'revision_sheet');

					// If the model DID emit a revision_sheet in the summary response, persist it
					// as a card message so it shows and reloads from history.
					if (!hadRevisionSheet && summaryResponse && summaryResponse.revision_sheet) {
						const savedRevModel = await savePhaseBlock('revision_sheet', summaryResponse.revision_sheet, '');
						if (savedRevModel) hadRevisionSheet = true;
					}

					if (!hadRevisionSheet) {
						try {
							console.log('[topic-chats] revision_sheet missing — synthesizing from session analytics');
							const metricsData = await calculateSessionMetrics(user_id, parseInt(topicId), updatedGoalsAfterProgress);
							const goalPerf = Array.isArray(metricsData.goal_performance) ? metricsData.goal_performance : [];
							const revisionSheetData = {
								topic: topic.title,
								concepts_covered: goalPerf.length > 0 ? goalPerf.map(g => g.goal_title) : updatedGoalsAfterProgress.map(g => g.title),
								definitions: [],
								key_points: goalPerf.length > 0
									? goalPerf.map(g => `${g.goal_title}: ${g.questions_asked} questions, ${g.correct_answers} correct (${g.score_percent}% accuracy)`)
									: [],
								common_mistakes: (metricsData.top_error_types || []).map(t => t.type),
								one_minute_recall: [],
								your_weak_spots: (metricsData.weak_goals || []).map(g => g.goal_title),
								overall_score_percent: metricsData.overall_score_percent,
								star_rating: metricsData.star_rating,
								performance_level: metricsData.performance_level
							};
							const savedRev = await savePhaseBlock('revision_sheet', revisionSheetData, '');
							if (savedRev) {
								if (!aiResponse.revision_sheet) aiResponse.revision_sheet = revisionSheetData;
								console.log('🔖 revision_sheet synthesized and saved as end card');
							}
						} catch (revErr) {
							console.error('❌ Failed to synthesize revision_sheet:', revErr.message);
						}
					}

					// Generate a 2-3 line performance analysis text bubble (shown after summary card)
					try {
						const goalBreakdown = updatedGoalsAfterProgress.map(g => {
							const p = g.chat_goal_progress?.[0]
							const acc = p && p.num_questions > 0 ? Math.round((p.num_correct / p.num_questions) * 100) : 0
							return `${g.title}: ${acc}% accuracy (${p?.num_correct || 0}/${p?.num_questions || 0} correct)`
						}).join(', ')
						const overallScore = aiResponse.session_summary?.overall_score_percent || 0

						const perfPrompt = `You are a supportive academic tutor. A student just finished a topic session.

Overall score: ${overallScore}%
Goal breakdown: ${goalBreakdown}

Write a SHORT 2-3 sentence performance summary for the student.
- Mention what they did well
- Identify 1-2 specific weak areas (low accuracy goals)
- Give one concrete improvement tip
- Warm, encouraging tone
- DO NOT start with "Great job" or "Well done"
- Return plain text only, no JSON, no bullet points`

						const perfText = await invokeModel(perfPrompt, [{ role: 'user', content: 'Generate summary' }], {
							temperature: 1,
							maxTokens: 150
						})

						if (perfText) {
							const savedPerfMsg = await prisma.admin_chat.create({
								data: {
									user_id: user_id,
									sender: 'ai',
									message: perfText,
									message_type: 'learning_report',
									options: [],
									diff_html: JSON.stringify({ title: 'Session Performance Summary', summary: perfText }),
									emoji: null,
									images: [],
									videos: [],
									links: []
								}
							})
							// Link to last completed goal so GET history finds it on reload
							const lastCompletedGoal = updatedGoalsAfterProgress.slice().reverse().find(g => g.chat_goal_progress?.[0]?.is_completed)
							if (lastCompletedGoal) {
								try {
									await prisma.chat_goal_progress.create({
										data: {
											chat_id: savedPerfMsg.id,
											goal_id: lastCompletedGoal.id,
											user_id: user_id,
											is_completed: true,
											num_questions: lastCompletedGoal.chat_goal_progress?.[0]?.num_questions || 0,
											num_correct: lastCompletedGoal.chat_goal_progress?.[0]?.num_correct || 0,
											num_incorrect: lastCompletedGoal.chat_goal_progress?.[0]?.num_incorrect || 0,
										}
									})
								} catch (_) {} // ignore duplicate
							}
							aiMessages.push(savedPerfMsg)
							console.log('✅ Performance analysis bubble saved')
						}
					} catch (perfErr) {
						console.error('❌ Failed to generate performance analysis:', perfErr.message)
					}
				} catch (summaryError) {
					console.error('Error generating session summary:', summaryError)
				}
			}
		}

		// AUTO-CONTINUE: If goal just completed but AI forgot to ask next goal's first question,
		// trigger a follow-up call so the conversation doesn't stall
		if (aiSignalsGoalComplete && currentGoal && completedGoalsCount < totalGoalsCount) {
			const lastAiMsg = aiMessages[aiMessages.length - 1]
			const lastMsgHasQuestion = lastAiMsg && lastAiMsg.message && lastAiMsg.message.includes('?')

			if (!lastMsgHasQuestion) {
				console.log(`\n🔄 AUTO-CONTINUE: Triggering follow-up for next goal "${currentGoal.title}"`)
				try {
					const updatedHistory = [
						...chatHistory,
						{ sender: 'user', message, message_type: 'text', created_at: new Date().toISOString() },
						...aiMessages.map(m => ({ sender: 'ai', message: m.message, message_type: m.message_type || 'text', created_at: m.created_at }))
					]

					const followUpResponse = await generateTopicChatResponse({
						userMessage: `Start ${currentGoal.title}`,
						topicTitle: topic.title,
						topicContent: topic.content || 'No additional content provided',
						chatHistory: updatedHistory,
						currentGoal,
						topicGoals
					})

					if (followUpResponse && followUpResponse.messages) {
						for (const fuMsg of followUpResponse.messages) {
							const fuMsgText = (fuMsg.message ?? '') || '';
							const fuMsgType = fuMsg.message_type || fuMsg.type || 'text';
							// Skip empty plain bubbles (same guard as saveAndLinkAiMessage) so a
							// follow-up turn never inserts an "empty..." artifact.
							if (!fuMsgText && fuMsgType === 'text' && !(fuMsg.options && fuMsg.options.length)) {
								console.warn('[topic-chats] Skipping empty follow-up AI bubble');
								continue;
							}
							const savedFuMsg = await prisma.admin_chat.create({
								data: {
									user_id: user_id,
									sender: 'ai',
									message: fuMsgText,
									message_type: fuMsgType,
									options: optionsToStrings(fuMsg.options || []),
									diff_html: null,
									emoji: fuMsg.emoji || null,
									images: [],
									videos: [],
									links: []
								},
								select: {
									id: true, sender: true, message: true, message_type: true,
									options: true, diff_html: true, emoji: true,
									images: true, videos: true, links: true, created_at: true
								}
							})
							aiMessages.push(savedFuMsg)
							console.log(`  ↪ Follow-up [${fuMsg.message_type}]: ${fuMsg.message.substring(0, 70)}`)
						}
					}
				} catch (fuErr) {
					console.error('❌ Auto-continue follow-up failed:', fuErr.message)
				}
			}
		}

		// If voice is enabled, pre-fetch/synthesize TTS for all new text messages in parallel
		if (voice_enabled) {
			try {
				console.log(`[Voice API] Parallel TTS synthesis started for ${aiMessages.length} messages`);
				const apiKey = process.env.SARVAM_API_KEY;
				if (apiKey) {
					await Promise.all(
						aiMessages
							.filter(m => !!m)
							.map(async (msg) => {
							if (
								msg.message_type === 'mermaid_diagram' ||
								msg.message_type === 'text_diagram' ||
								msg.message_type === 'youtube_video' ||
								msg.message_type === 'google_image' ||
								msg.message_type === 'session_summary' ||
								msg.message_type === 'score_prediction' ||
								!msg.message ||
								!msg.message.trim()
							) {
								return;
							}

							let cleanText = msg.message
								.replace(/<[^>]+>/g, "") // strip HTML tags
								.replace(/\*\*([^*]+)\*\*/g, "$1") // strip markdown bold
								.replace(/_([^_]+)_/g, "$1") // strip markdown italic
								.trim();

							if (cleanText.length > 500) {
								cleanText = cleanText.substring(0, 500) + "...";
							}

							if (!cleanText) return;

							try {
								const ttsResponse = await axios.post(
									'https://api.sarvam.ai/text-to-speech',
									{
										text: cleanText,
										speaker: 'priya',
										target_language_code: 'en-IN',
										model: 'bulbul:v3',
										pace: 1.0,
										sample_rate: 24000
									},
									{
										headers: {
											'api-subscription-key': apiKey,
											'Content-Type': 'application/json'
										},
										timeout: 8000 // 8 seconds timeout
									}
								);

								if (ttsResponse.data && ttsResponse.data.audios && ttsResponse.data.audios.length > 0) {
									msg.audio = ttsResponse.data.audios[0];
								}
							} catch (ttsErr) {
								console.error(`[Voice API] Parallel TTS failed for message "${msg.id}":`, ttsErr.message);
							}
						})
					);
					console.log('[Voice API] Parallel TTS synthesis complete');
				}
			} catch (err) {
				console.error('[Voice API] Error in parallel TTS processing:', err.message);
			}
		}

		// Update user's chat count
		await prisma.users.update({
			where: { user_id: user_id },
			data: { num_chats: { increment: 1 } }
		})

		return res.status(201).json({
			userMessage,
			aiMessages,
			feedback: aiResponse.feedback || (userCorrection?.feedback) || null,
			userCorrection: userCorrection || null,
			session_summary: aiResponse.session_summary || null,
			score_prediction: scorePrediction || null,
			all_goals_completed: completedGoalsCount >= totalGoalsCount, // Add flag for frontend
			goals: topicGoals, // Include updated goals for frontend UI
			// Pass through diagram and media from AI response + fetched results
			mermaid_diagram: aiResponse.mermaid_diagram || null,
			text_diagram: aiResponse.text_diagram || null,
			// Include both the AI suggestion AND the fetched results
			youtube_video: aiResponse.youtube_video || null,
			youtube_results: fetchedVideos || [],
			google_image: aiResponse.google_image || null,
			image_results: fetchedImages || []
		})
	} catch (err) {
		console.error('Error sending topic chat message:', err)
		return res.status(500).json({ error: 'Server error while sending message' })
	}
})


/**
 * POST /api/topic-chats/:topicId/option
 * Handle user selecting an option (e.g., "Got it" or "Explain") from a corrected bubble
 */
router.post('/:topicId/option', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id;
	const { topicId } = req.params;
	const { chatId, option } = req.body;

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' });
	}

	if (!topicId || isNaN(parseInt(topicId))) {
		return res.status(400).json({ error: 'Valid topic ID is required' });
	}

	if (!option) {
		return res.status(400).json({ error: 'Option is required' });
	}

	// Handle chatId - it might be a BigInt stored as string
	// Handle chatId - it might be a BigInt stored as string or a float (optimistic ID)
	let parsedChatId;
	try {
		if (chatId !== undefined && chatId !== null) {
			// Handle float format (e.g. 1736077383456.432) often sent by frontend for optimistic updates
			const numId = Number(chatId);
			if (!isNaN(numId)) {
				parsedChatId = BigInt(Math.floor(numId));
			} else {
				parsedChatId = BigInt(chatId);
			}

			// Convert to number if it fits in safe integer range
			if (parsedChatId <= Number.MAX_SAFE_INTEGER) {
				parsedChatId = Number(parsedChatId);
			}

			// 🔧 FIX: Check for Postgres INT4 max value (2147483647)
			// If userId is optimistic (timestamp-like), it will exceed this and crash Prisma
			if (parsedChatId > 2147483647) {
				console.warn('⚠️ ChatId exceeds INT4 limit (likely optimistic ID):', parsedChatId);
				parsedChatId = null; // Skip DB lookup
			}
		}
	} catch (e) {
		console.warn('⚠️ Invalid chatId format received:', chatId, e.message);
		// Proceed without parsedChatId (skipping feedback linking) rather than crashing
	}

	try {
		// Verify topic exists
		const topic = await prisma.global_topics.findUnique({
			where: {
				id: parseInt(topicId)
			}
		});

		if (!topic) {
			return res.status(404).json({ error: 'Topic not found' });
		}

		// Update the related chat_process feedback to record the selected option (if exists)
		try {
			if (parsedChatId) {
				const relatedProcess = await prisma.chat_process.findFirst({
					where: {
						chat_id: typeof parsedChatId === 'number' ? parsedChatId : undefined
					}
				});
				if (relatedProcess) {
					const existingFeedback = relatedProcess.feedback || {};
					const updatedFeedback = { ...existingFeedback, option_selected: option };
					await prisma.chat_process.update({
						where: { id: relatedProcess.id },
						data: { feedback: updatedFeedback }
					});
				}
			}
		} catch (e) {
			console.log('No chat_process found for this message (might be session summary):', e.message);
		}

		// Build recent chat history for context
		const topicGoalsForHistory = await prisma.global_topic_goals.findMany({ where: { topic_id: parseInt(topicId) }, select: { id: true } });
		const goalIdsForHistory = topicGoalsForHistory.map(g => g.id);

		const recentMessages = await prisma.admin_chat.findMany({
			where: {
				chat_goal_progress: {
					some: {
						goal_id: { in: goalIdsForHistory },
						user_id: user_id
					}
				}
			},
			orderBy: { created_at: 'desc' },
			take: 50,
			select: { sender: true, message: true, message_type: true }
		});

		const chatHistory = recentMessages.reverse();

		// Fetch topic goals and current goal WITH progress data
		const topicGoals = await prisma.global_topic_goals.findMany({
			where: { topic_id: parseInt(topicId) },
			orderBy: { order: 'asc' },
			include: {
				chat_goal_progress: {
					where: { user_id: user_id },
					orderBy: { updated_at: 'desc' },
					take: 1
				}
			}
		});
		let currentGoal = null;
		for (const goal of topicGoals) {
			const progress = goal.chat_goal_progress?.[0];
			if (!progress || !progress.is_completed) {
				currentGoal = goal;
				break;
			}
		}

		// --- Check and update goal completion status ---
		if (currentGoal) {
			try {
				// Recompute topic completion percent
				const allGoalsProgress = await prisma.chat_goal_progress.groupBy({
					by: ['goal_id'],
					where: { user_id: user_id, goal_id: { in: topicGoals.map(g => g.id) }, is_completed: true }
				});
				const completedGoalsCount = allGoalsProgress.length;
				const totalGoalsCount = topicGoals.length;
				const completionPercent = totalGoalsCount > 0 ? Math.round((completedGoalsCount / totalGoalsCount) * 100) : 0;
				await prisma.user_topic_progress.upsert({
					where: {
						user_id_topic_id: {
							user_id: user_id,
							topic_id: parseInt(topicId)
						}
					},
					update: {
						completion_percent: completionPercent,
						is_completed: completionPercent >= 100,
						last_accessed_at: new Date()
					},
					create: {
						user_id: user_id,
						topic_id: parseInt(topicId),
						completion_percent: completionPercent,
						is_completed: completionPercent >= 100,
						last_accessed_at: new Date()
					}
				});

				// Re-fetch goals with updated progress
				const updatedTopicGoals = await prisma.global_topic_goals.findMany({
					where: { topic_id: parseInt(topicId) },
					orderBy: { order: 'asc' },
					include: {
						chat_goal_progress: {
							where: { user_id: user_id },
							orderBy: { updated_at: 'desc' },
							take: 1
						}
					}
				});

				// Re-determine current goal
				let updatedCurrentGoal = null;
				for (const goal of updatedTopicGoals) {
					const progress = goal.chat_goal_progress?.[0];
					if (!progress || !progress.is_completed) {
						updatedCurrentGoal = goal;
						break;
					}
				}
			} catch (e) {
				console.error('Failed to update chat_goal_progress after option selection:', e.message);
			}
		}

		// Call the topic chat generator
		const finalCurrentGoal = currentGoal; // Simplified for now, should ideally be updatedCurrentGoal if available
		const finalTopicGoals = topicGoals;

		// 📊 INCREMENT EXPLAIN COUNT
		if (option === 'Explain' || option === 'Explain more') {
			try {
				if (parsedChatId) {
					const recentLearningTurn = await prisma.learning_turns.findFirst({
						where: {
							user_id: user_id,
							goal_id: finalCurrentGoal?.id,
							chat_id: typeof parsedChatId === 'number' ? parsedChatId : undefined
						},
						orderBy: { created_at: 'desc' }
					});

					if (recentLearningTurn) {
						await incrementExplainCount(recentLearningTurn.id);
					}
				}
			} catch (explainCountError) {
				console.error('❌ Failed to increment explain count:', explainCountError);
			}
		}

		// --- HANDLE "End Session" SPECIALLY ---
		if (option === 'End Session') {
			console.log('🛑 User requested to user: End Session');
			return res.status(200).json({
				aiMessages: [{
					sender: 'ai',
					message: 'Session ended.',
					message_type: 'text',
					options: [],
					created_at: new Date().toISOString()
				}],
				goals: topicGoals
			});
		}

		let aiResponse;
		try {
			if (option === 'Got it') {
				const modifiedHistory = [...chatHistory, { sender: 'system', message: 'IMPORTANT: The user has acknowledged the previous correction. Do NOT repeat the previous question or treat this as an answer. Ask a NEW question about the current goal to continue the lesson. Generate a "messages" array with the next question - do NOT use user_correction format.' }];
				aiResponse = await generateTopicChatResponse({
					userMessage: option,
					topicTitle: topic.title,
					topicContent: topic.content || 'No additional content provided',
					chatHistory: modifiedHistory,
					currentGoal: finalCurrentGoal,
					topicGoals: finalTopicGoals
				});
			} else if (option === 'Explain' || option === 'Explain more') {
				const modifiedHistory = [...chatHistory, { sender: 'system', message: `IMPORTANT: The user clicked "${option}". Provide a clear, detailed explanation of the concept with examples. Use 2-3 short messages. The LAST message should include options: ["Got it", "Explain more"]. Do NOT ask a new question yet - focus on explaining the previous correction thoroughly.` }];
				aiResponse = await generateTopicChatResponse({
					userMessage: option,
					topicTitle: topic.title,
					topicContent: topic.content || 'No additional content provided',
					chatHistory: modifiedHistory,
					currentGoal: finalCurrentGoal,
					topicGoals: finalTopicGoals
				});
			} else {
				aiResponse = await generateTopicChatResponse({
					userMessage: option,
					topicTitle: topic.title,
					topicContent: topic.content || 'No additional content provided',
					chatHistory,
					currentGoal: finalCurrentGoal,
					topicGoals: finalTopicGoals
				});
			}
		} catch (aiError) {
			console.error('Error generating AI response for option selection:', aiError);
			aiResponse = { messages: [{ message: "I'm having trouble right now.", message_type: 'text' }] };
		}

		// Save AI messages
		const aiMessages = [];
		for (let i = 0; i < (aiResponse.messages || []).length; i++) {
			const aiMsg = aiResponse.messages[i];
			const savedAiMessage = await prisma.admin_chat.create({
				data: {
					user_id: user_id,
					sender: 'ai',
					message: aiMsg.message ?? aiMsg.content ?? '',
					message_type: aiMsg.message_type ?? aiMsg.type ?? 'text',
					options: optionsToStrings(aiMsg.options),
					images: (aiMsg.images || []).map(x => typeof x === 'string' ? x : (x.url || JSON.stringify(x))),
					videos: (aiMsg.videos || []).map(x => typeof x === 'string' ? x : (x.url || JSON.stringify(x))),
					links: (aiMsg.links || []).map(x => typeof x === 'string' ? x : (x.url || JSON.stringify(x)))
				}
			});

			// Unpack serialized media arrays for returned object
			savedAiMessage.videos = (savedAiMessage.videos || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			savedAiMessage.images = (savedAiMessage.images || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			savedAiMessage.links = (savedAiMessage.links || []).map(item => {
				if (typeof item === 'string' && item.trim().startsWith('{')) {
					try {
						return JSON.parse(item)
					} catch (e) {
						return item
					}
				}
				return item
			})
			savedAiMessage.options = optionsFromDb(savedAiMessage.options);

			aiMessages.push(savedAiMessage);

			if (finalCurrentGoal) {
				// Link logic...
				try {
					const existingLink = await prisma.chat_goal_progress.findFirst({
						where: {
							chat_id: savedAiMessage.id,
							goal_id: finalCurrentGoal.id,
							user_id: user_id
						}
					});

					if (!existingLink) {
						// ALWAYS create a link for this specific AI message to the current goal
						// This ensures the message appears when fetching history for this goal
						// We copy the current stats from the existing goal progress (if any) or start fresh
						const currentStats = await prisma.chat_goal_progress.findFirst({
							where: {
								user_id: user_id,
								goal_id: finalCurrentGoal.id
							},
							orderBy: {
								updated_at: 'desc'
							}
						});

						await prisma.chat_goal_progress.create({
							data: {
								chat_id: savedAiMessage.id,
								goal_id: finalCurrentGoal.id,
								user_id: user_id,
								is_completed: currentStats ? currentStats.is_completed : false,
								num_questions: currentStats ? currentStats.num_questions : 0,
								num_correct: currentStats ? currentStats.num_correct : 0,
								num_incorrect: currentStats ? currentStats.num_incorrect : 0
							}
						});
					}
				} catch (e) { }
			}
		}

		// Return updated goals
		const updatedGoalsForClient = await prisma.global_topic_goals.findMany({
			where: { topic_id: parseInt(topicId) },
			orderBy: { order: 'asc' },
			include: {
				chat_goal_progress: {
					where: { user_id: user_id },
					orderBy: { created_at: 'desc' },
					take: 1
				}
			}
		});

		return res.status(201).json({ aiMessages, userCorrection: aiResponse.user_correction || null, feedback: aiResponse.feedback || null, goals: updatedGoalsForClient });
	} catch (err) {
		console.error('Error handling option selection:', err);
		return res.status(500).json({ error: 'Server error while processing option' });
	}
});

// POST /api/topic-chats/:topicId/update-time
// Sole writer of study time. session_time_seconds is a DELTA accrued since the
// last write (not cumulative). action drives the session lifecycle:
//   heartbeat -> session stays open (end_time = NULL), seconds recorded
//   pause     -> seconds recorded, then session closed (end_time stamped)
//   complete  -> seconds recorded, then session closed and marked complete
// Reopening a topic with no open (end_time IS NULL) session starts a fresh one.
router.post('/:topicId/update-time', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { topicId } = req.params
	const { session_time_seconds: deltaSeconds, action } = req.body
	const requestedAction = action === 'complete' ? 'complete' : (action === 'pause' ? 'pause' : 'heartbeat')

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!topicId || isNaN(parseInt(topicId))) {
		return res.status(400).json({ error: 'Valid topic ID is required' })
	}

	const safeDelta = deltaSeconds === undefined || deltaSeconds < 0 ? 0 : Math.floor(deltaSeconds)

	try {
		// Verify topic exists
		const topic = await prisma.global_topics.findUnique({
			where: {
				id: parseInt(topicId)
			},
			select: {
				id: true,
				subject_id: true
			}
		})

		if (!topic) {
			return res.status(404).json({ error: 'Topic not found' })
		}

		// Locate the open session for this user/topic (end_time IS NULL = in progress)
		const activeSession = await prisma.study_sessions.findFirst({
			where: {
				user_id: user_id,
				topic_id: parseInt(topicId),
				end_time: null
			},
			orderBy: {
				start_time: 'desc'
			}
		});

		// For heartbeat: just accumulate seconds against the open session.
		// For pause/complete WITHOUT an open session (e.g. reload, or completed in
		// a prior send), nothing is accrued — the delta is already persisted.
		if (activeSession) {
			if (safeDelta > 0) {
				await prisma.study_sessions.update({
					where: { id: activeSession.id },
					data: {
						duration_seconds: {
							increment: safeDelta
						}
					}
				});
			}

			// Close the session on pause/complete
			if (requestedAction === 'pause' || requestedAction === 'complete') {
				await prisma.study_sessions.update({
					where: { id: activeSession.id },
					data: {
						end_time: new Date()
					}
				});
			}
		} else if (safeDelta > 0) {
			// No open session: a fresh start after the prior one was closed.
			// The delta represents seconds on this new visit.
			await prisma.study_sessions.create({
				data: {
					user_id: user_id,
					topic_id: parseInt(topicId),
					subject_id: topic.subject_id,
					start_time: new Date(),
					end_time: requestedAction === 'pause' || requestedAction === 'complete'
						? new Date()
						: null,
					duration_seconds: safeDelta
				}
			});
		}

		// Update aggregated time on topic in user_topic_progress
		if (safeDelta > 0) {
			await prisma.user_topic_progress.upsert({
				where: {
					user_id_topic_id: {
						user_id: user_id,
						topic_id: parseInt(topicId)
					}
				},
				update: {
					time_spent_seconds: {
						increment: safeDelta
					},
					last_accessed_at: new Date()
				},
				create: {
					user_id: user_id,
					topic_id: parseInt(topicId),
					time_spent_seconds: safeDelta,
					last_accessed_at: new Date()
				}
			});
		}

		return res.status(200).json({ success: true })
	} catch (err) {
		console.error('Error updating topic time:', err)
		return res.status(500).json({ error: 'Server error while updating time' })
	}
})

module.exports = router

