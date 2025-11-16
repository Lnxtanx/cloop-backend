const express = require('express')
const router = express.Router()
const { authenticateToken } = require('../../middleware/auth')
const { generateTopicChatResponse, generateTopicGreeting, generateTopicGoals } = require('../../services/topic_chat')
const { createLearningTurn, incrementExplainCount, calculateMasteryScore } = require('../../services/learning_turns_tracker')

const prisma = require('../../lib/prisma')
// Note: Total of 10 questions will be asked across ALL goals (not per goal)
// The AI will intelligently distribute questions across goals

// Helper to normalize text for duplicate detection
function normalizeText(s) {
	if (!s || typeof s !== 'string') return ''
	return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

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
		// First verify that the user has access to this topic
		const topic = await prisma.topics.findFirst({
			where: {
				id: parseInt(topicId),
				user_id: user_id
			},
			include: {
				chapter_id_rel: {
					select: {
						id: true,
						title: true,
						subject_id: true
					}
				},
				subject_id_rel: {
					select: {
						id: true,
						name: true,
						code: true
					}
				}
			}
		})

		if (!topic) {
			return res.status(403).json({ error: 'Topic not found or user does not have access' })
		}

		// Fetch topic goals (we need their ids to find related admin_chat messages)
		const topicGoalsForIds = await prisma.topic_goals.findMany({
			where: { topic_id: parseInt(topicId) },
			select: { id: true },
		})

		const topicGoalIds = topicGoalsForIds.map(g => g.id)

		// 🔧 FIX: Fetch ALL chat messages for this topic using learning_turns
		// learning_turns stores the complete Q&A history with better tracking
		const learningTurns = await prisma.learning_turns.findMany({
			where: {
				topic_id: parseInt(topicId),
				user_id: user_id
			},
			orderBy: {
				created_at: 'asc'
			},
			select: {
				id: true,
				chat_id: true,
				question_text: true,
				user_answer_raw: true,
				corrected_answer: true,
				diff_html: true,
				is_correct: true,
				score_percent: true,
				error_type: true,
				feedback_text: true,
				sender: true,
				created_at: true
			}
		})

		console.log('📊 Learning Turns Found:', learningTurns.length);

		// Build complete chat history from learning_turns
		const chatMessages = []
		
		for (const turn of learningTurns) {
			// Add AI question
			if (turn.question_text) {
				chatMessages.push({
					id: turn.chat_id,
					sender: 'ai',
					message: turn.question_text,
					message_type: 'text',
					options: [],
					diff_html: null,
					emoji: null,
					images: [],
					videos: [],
					links: [],
					created_at: turn.created_at
				})
			}

			// Add user answer (raw)
			if (turn.user_answer_raw) {
				chatMessages.push({
					id: turn.chat_id + 10000, // Offset to avoid ID collision
					sender: 'user',
					message: turn.user_answer_raw,
					message_type: 'text',
					options: [],
					diff_html: null,
					emoji: null,
					images: [],
					videos: [],
					links: [],
					created_at: turn.created_at
				})
			}

			// Add correction/feedback if answer was incorrect or needs feedback
			if (turn.diff_html || turn.corrected_answer || turn.feedback_text) {
				const feedbackEmoji = turn.is_correct ? '😊' : 
					turn.score_percent === 0 ? '😓' : 
					turn.score_percent < 50 ? '😢' : '😅'

				chatMessages.push({
					id: turn.chat_id + 20000, // Offset to avoid ID collision
					sender: 'ai',
					message: turn.corrected_answer || turn.feedback_text || '',
					message_type: 'user_correction',
					options: ['Got it', 'Explain'],
					diff_html: turn.diff_html || '',
					emoji: feedbackEmoji,
					images: [],
					videos: [],
					links: [],
					created_at: turn.created_at
				})
			}
		}

		// Also fetch admin_chat messages (for session summary and other AI messages)
		const adminChatMessages = await prisma.admin_chat.findMany({
			where: {
				user_id: user_id,
				chat_goal_progress: {
					some: {
						goal_id: { in: topicGoalIds }
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
		})

		console.log('💬 Admin Chat Messages Found:', adminChatMessages.length);

		// Merge admin_chat messages with learning_turns messages
		// Admin chat contains session summaries, greetings, etc.
		for (const msg of adminChatMessages) {
			// Avoid duplicates - only add if not already in chatMessages
			const isDuplicate = chatMessages.some(existing => 
				existing.message === msg.message && 
				Math.abs(new Date(existing.created_at).getTime() - new Date(msg.created_at).getTime()) < 1000
			)
			
			if (!isDuplicate) {
				chatMessages.push(msg)
			}
		}

		// Sort all messages by created_at
		chatMessages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

		console.log('✅ Total Chat Messages:', chatMessages.length);

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
		const topicGoals = await prisma.topic_goals.findMany({
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
			
			// Generate greeting with goals context
			const greetingData = await generateTopicGreeting(topic.title, topic.content, topicGoals)
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
				
				// Store each greeting message in database
				for (const msg of initialGreeting) {
					// First create the admin_chat record
					const chatRecord = await prisma.admin_chat.create({
						data: {
							sender: 'ai',
							message: msg.message,
							message_type: msg.message_type || 'text',
							emoji: msg.emoji || null,
							options: msg.options || [],
							users: {
								connect: { user_id: user_id }
							}
						}
					});
					
					// Then create or connect to chat_goal_progress using the chat_id
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
				await prisma.topic_goals.create({
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
		const updatedGoals = await prisma.topic_goals.findMany({
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

		return res.status(200).json({
			topic: {
				id: topic.id,
				title: topic.title,
				content: topic.content,
				is_completed: topic.is_completed,
				completion_percent: topic.completion_percent,
				time_spent_seconds: topic.time_spent_seconds || 0,
					chapter: topic.chapter_id_rel,
					subject: topic.subject_id_rel
			},
			messages: chatMessages,
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
	const { message, file_url, file_type, session_time_seconds } = req.body

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

	try {
		console.log('\n========== NEW MESSAGE RECEIVED ==========');
		console.log('📱 User:', user_id);
		console.log('📚 Topic ID:', topicId);
		console.log('💬 User Message:', message ? message.substring(0, 100) : 'None');
		console.log('📎 File:', file_url || 'None');
		
		// Verify user has access to this topic
		const topic = await prisma.topics.findFirst({
			where: {
				id: parseInt(topicId),
				user_id: user_id
			},
				include: {
					chapter_id_rel: {
						select: {
							title: true
						}
					},
					subject_id_rel: {
						select: {
							name: true
						}
					}
				}
		})

		if (!topic) {
			return res.status(403).json({ error: 'Topic not found or user does not have access' })
		}

		// Get recent chat history for context (from admin_chat linked via chat_goal_progress)
		// First get goal ids for this topic
		const topicGoalsForHistory = await prisma.topic_goals.findMany({
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
			take: 10,
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
		const topicGoals = await prisma.topic_goals.findMany({
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

		// Create chat_goal_progress link if currentGoal exists (so this chat is associated with goal tracking)
		if (currentGoal) {
			const existingLink = await prisma.chat_goal_progress.findFirst({
				where: {
					chat_id: userMessage.id,
					goal_id: currentGoal.id,
					user_id: user_id
				}
			})

			if (!existingLink) {
				// Check if progress already exists for this goal
				const existingProgress = await prisma.chat_goal_progress.findFirst({
					where: {
						user_id: user_id,
						goal_id: currentGoal.id
					}
				})

				if (!existingProgress) {
					// Create initial progress entry
					await prisma.chat_goal_progress.create({
						data: {
							chat_id: userMessage.id,
							goal_id: currentGoal.id,
							user_id: user_id,
							is_completed: false,
							num_questions: 0,
							num_correct: 0,
							num_incorrect: 0
						}
					})
					console.log(`✅ Created chat_goal_progress link for goal: ${currentGoal.title}`)
				}
			}
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

		// 🔧 PRE-CHECK: If currentGoal exists, check if answering this question will complete ALL goals
		// This allows us to trigger session end immediately after last answer
		let willCompleteAllGoals = false
		if (currentGoal) {
			const existingProgress = await prisma.chat_goal_progress.findFirst({
				where: {
					user_id: user_id,
					goal_id: currentGoal.id
				},
				orderBy: {
					updated_at: 'desc'
				}
			})
			
			// Check if this answer will be the 2nd question for this goal (completing it)
			const currentQuestions = existingProgress?.num_questions || 0
			const willCompleteCurrentGoal = (currentQuestions + 1) >= 2 // 2 questions per goal
			
			if (willCompleteCurrentGoal) {
				// Check how many goals are already complete
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
				
				// Will this complete ALL goals?
				willCompleteAllGoals = (completedGoals.length + 1) >= topicGoals.length
				
				if (willCompleteAllGoals) {
					console.log('🎯 DETECTED: This answer will complete ALL GOALS! Preparing session summary...')
				}
			}
		}

		// Generate AI response using agentic tutor
		let aiResponse
		try {
			aiResponse = await generateTopicChatResponse(
				message || 'User shared a file',
				topic.title,
				topic.content || 'No additional content provided',
				chatHistory,
				currentGoal,
				topicGoals,
				user_id,
				parseInt(topicId)
			)
		} catch (aiError) {
			console.error('Error generating AI response:', aiError)
			// Fallback response
			aiResponse = {
				messages: [
					{ message: "I'm having trouble right now.", message_type: "text" },
					{ message: "Could you try again?", message_type: "text" }
				]
			}
		}

		// Duplicate-question fallback (retry once) — if the model returns a question identical
		// to the last AI question in chatHistory, ask it again with an explicit instruction
		try {
			const lastAi = chatHistory.slice().reverse().find(m => m.sender === 'ai')
			if (aiResponse && Array.isArray(aiResponse.messages) && lastAi) {
				const candidate = aiResponse.messages.find(m => m.message && m.message.includes('?')) || aiResponse.messages[0]
				if (candidate && candidate.message) {
					const candText = normalizeText(candidate.message)
					const lastText = normalizeText(lastAi.message)
					if (candText && lastText && candText === lastText) {
						// Retry once with a firm instruction in the history
						chatHistory.push({ sender: 'system', message: 'Do NOT repeat the previous AI question. Rephrase or ask a different sub-question about the same goal.' })
						try {
							const retryResp = await generateTopicChatResponse(message || 'User shared a file', topic.title, topic.content || 'No additional content provided', chatHistory, currentGoal, topicGoals)
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
			const idx = aiResponse.messages.findIndex(m => m.message_type === 'user_correction' || (m.message && /<del>|<ins>/.test(m.message)));
			if (idx !== -1) {
				const correctionMsg = aiResponse.messages.splice(idx, 1)[0];
				// Normalize to user_correction shape
				const inferredUserCorrection = {
					message_type: 'user_correction',
					diff_html: correctionMsg.message || null,
					complete_answer: correctionMsg.complete_answer || correctionMsg.message || null,
					options: correctionMsg.options || ['Got it', 'Explain'],
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

				// Update the admin_chat placeholder to contain the corrected user bubble
				try {
					await prisma.admin_chat.update({
						where: { id: userMessage.id },
						data: {
							diff_html: inferredUserCorrection.diff_html,
							message: inferredUserCorrection.complete_answer || userMessage.message,
							message_type: 'user_correction',
							emoji: inferredUserCorrection.emoji || null,
							options: inferredUserCorrection.options || []
						}
					})
					// Reflect update in userMessage object for response
					userMessage.diff_html = inferredUserCorrection.diff_html;
					userMessage.message = inferredUserCorrection.complete_answer || userMessage.message;
					userMessage.message_type = 'user_correction';
					userMessage.emoji = inferredUserCorrection.emoji || null;
					userMessage.options = inferredUserCorrection.options || [];
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

			// Update the admin_chat placeholder to contain the corrected user bubble (what frontend will display)
			await prisma.admin_chat.update({
				where: { id: userMessage.id },
				data: {
					diff_html: userCorrection.diff_html,
					message: userCorrection.complete_answer || userMessage.message,
					message_type: 'user_correction',
					emoji: userCorrection.emoji || null,
					options: userCorrection.options || []
				}
			});

			/**
			 * POST /api/topic-chats/:topicId/option
			 * Handle user selecting an option (e.g., "Got it" or "Explain") from a corrected bubble
			 * This endpoint records the user's choice against the original chat_process and invokes the
			 * topic chat generator so the AI can respond (acknowledgement or explanation + next question).
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

				if (!chatId || !option) {
					return res.status(400).json({ error: 'chatId and option are required' });
				}

				// Handle chatId - it might be a BigInt stored as string
				let parsedChatId;
				try {
					parsedChatId = BigInt(chatId);
					// Convert to number if it fits in safe integer range
					if (parsedChatId <= Number.MAX_SAFE_INTEGER) {
						parsedChatId = Number(parsedChatId);
					}
				} catch (e) {
					return res.status(400).json({ error: 'Invalid chatId format' });
				}

				try {
					// Verify user has access to this topic
					const topic = await prisma.topics.findFirst({
						where: {
							id: parseInt(topicId),
							user_id: user_id
						}
					});

					if (!topic) {
						return res.status(403).json({ error: 'Topic not found or user does not have access' });
					}

					// Skip chat validation - session summary messages may have auto-generated IDs
					// Just proceed with the option handling

					// Update the related chat_process feedback to record the selected option (if exists)
					// Use try-catch since session summary might not have a chat_process
					try {
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
					} catch (e) {
						console.log('No chat_process found for this message (might be session summary):', e.message);
					}

					// We'll compute goal progress after we determine the current goal (below) to avoid referencing it early.

					// Build recent chat history for context (same as in message route)
					const topicGoalsForHistory = await prisma.topic_goals.findMany({ where: { topic_id: parseInt(topicId) }, select: { id: true } });
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
						take: 10,
						select: { sender: true, message: true, message_type: true }
					});

					const chatHistory = recentMessages.reverse();

					// Fetch topic goals and current goal WITH progress data
					const topicGoals = await prisma.topic_goals.findMany({ 
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

				// --- Check and update goal completion status (do NOT increment questions - that's done when answer is submitted) ---
				if (currentGoal) {
					try {
						// Check current progress for this goal
						let prog = await prisma.chat_goal_progress.findFirst({ where: { user_id: user_id, goal_id: currentGoal.id } });
						
						if (prog) {
							// ALL goals require 2 questions to complete
							const numQ = prog.num_questions || 0;
							const numC = prog.num_correct || 0;
							const percent = numQ > 0 ? Math.round((numC / numQ) * 100) : 0;
							const requiredQuestions = 2;
							// Mark completed only if 2 questions have been asked
							const markCompleted = (numQ >= requiredQuestions);
							
							if (markCompleted && !prog.is_completed) {
								await prisma.chat_goal_progress.update({ where: { id: prog.id }, data: { is_completed: true } });
								console.log(`✅ Goal marked complete: ${currentGoal.title} (${numQ} questions, ${percent}% accuracy)`);
							}
						}							// Recompute topic completion percent
							const allGoalsProgress = await prisma.chat_goal_progress.groupBy({
								by: ['goal_id'],
								where: { user_id: user_id, goal_id: { in: topicGoals.map(g => g.id) }, is_completed: true }
							});
							const completedGoalsCount = allGoalsProgress.length;
							const totalGoalsCount = topicGoals.length;
							const completionPercent = totalGoalsCount > 0 ? Math.round((completedGoalsCount / totalGoalsCount) * 100) : 0;
							await prisma.topics.update({ where: { id: parseInt(topicId) }, data: { completion_percent: completionPercent, is_completed: completionPercent >= 50 } });

							// Re-fetch goals with updated progress so AI sees latest completion status
							const updatedTopicGoals = await prisma.topic_goals.findMany({ 
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
							
							// Re-determine current goal with updated completion status
							let updatedCurrentGoal = null;
							for (const goal of updatedTopicGoals) {
								const progress = goal.chat_goal_progress?.[0];
								if (!progress || !progress.is_completed) {
									updatedCurrentGoal = goal;
									break;
								}
							}
							
							console.log(`🎯 Updated Active Goal: ${updatedCurrentGoal ? updatedCurrentGoal.title : 'All goals completed!'}`);
						} catch (e) {
							console.error('Failed to update chat_goal_progress after option selection:', e.message);
						}
					}

				// Call the topic chat generator with the option as the user reply (use updated goals/currentGoal if available)
				const finalCurrentGoal = typeof updatedCurrentGoal !== 'undefined' ? updatedCurrentGoal : currentGoal;
				const finalTopicGoals = typeof updatedTopicGoals !== 'undefined' ? updatedTopicGoals : topicGoals;
				
				// 📊 INCREMENT EXPLAIN COUNT - Track when user requests explanations
				if (option === 'Explain' || option === 'Explain more') {
					try {
						// Find the most recent learning turn for this chat/goal to increment explain count
						const recentLearningTurn = await prisma.learning_turns.findFirst({
							where: {
								user_id: user_id,
								goal_id: finalCurrentGoal?.id,
								chat_id: typeof parsedChatId === 'number' ? parsedChatId : undefined
							},
							orderBy: {
								created_at: 'desc'
							}
						});

						if (recentLearningTurn) {
							await incrementExplainCount(recentLearningTurn.id);
							console.log(`🔄 Incremented explain count for learning turn ${recentLearningTurn.id}`);
						}
					} catch (explainCountError) {
						console.error('❌ Failed to increment explain count:', explainCountError);
						// Don't fail the request if this fails
					}
				}

				let aiResponse;
				try {
					// If user clicked "Got it", ask for next question without sending "Got it" as user message
					// If user clicked "Explain", provide detailed explanation
					if (option === 'Got it') {
						// User acknowledged the correction - ask AI for the next question
						// Add a system message to prompt for next question
						const modifiedHistory = [...chatHistory, { sender: 'system', message: 'IMPORTANT: The user has acknowledged the previous correction. Do NOT repeat the previous question or treat this as an answer. Ask a NEW question about the current goal to continue the lesson. Generate a "messages" array with the next question - do NOT use user_correction format.' }];
						aiResponse = await generateTopicChatResponse('', topic.title, topic.content || 'No additional content provided', modifiedHistory, finalCurrentGoal, finalTopicGoals);
					} else if (option === 'Explain' || option === 'Explain more') {
						// User wants more explanation - add instruction to explain the concept in detail
						const modifiedHistory = [...chatHistory, { sender: 'system', message: `IMPORTANT: The user clicked "${option}". Provide a clear, detailed explanation of the concept with examples. Use 2-3 short messages. The LAST message should include options: ["Got it", "Explain more"]. Do NOT ask a new question yet - focus on explaining the previous correction thoroughly.` }];
						aiResponse = await generateTopicChatResponse('', topic.title, topic.content || 'No additional content provided', modifiedHistory, finalCurrentGoal, finalTopicGoals);
					} else {
						// Other option - send it to AI
						aiResponse = await generateTopicChatResponse(option, topic.title, topic.content || 'No additional content provided', chatHistory, finalCurrentGoal, finalTopicGoals);
					}
				} catch (aiError) {
					console.error('Error generating AI response for option selection:', aiError);
					aiResponse = { messages: [ { message: "I'm having trouble right now.", message_type: 'text' } ] };
				}					// Duplicate-question fallback in option flow (retry once)
					try {
						const lastAi = chatHistory.slice().reverse().find(m => m.sender === 'ai');
						if (aiResponse && Array.isArray(aiResponse.messages) && lastAi) {
							const candidate = aiResponse.messages.find(m => m.message && m.message.includes('?')) || aiResponse.messages[0];
							if (candidate && candidate.message) {
								const candText = normalizeText(candidate.message);
								const lastText = normalizeText(lastAi.message);
								if (candText && lastText && candText === lastText) {
									chatHistory.push({ sender: 'system', message: 'Do NOT repeat the previous AI question. Rephrase or ask a different sub-question about the same goal.' });
									try {
										// 🔧 FIX: Use empty string for "Got it" option in retry, not the option text itself
										const retryUserMessage = (option === 'Got it') ? '' : option;
										const retryResp = await generateTopicChatResponse(retryUserMessage, topic.title, topic.content || 'No additional content provided', chatHistory, currentGoal, topicGoals);
										if (retryResp) aiResponse = retryResp;
									} catch (retryErr) {
										console.error('Retry for duplicate question in option flow failed:', retryErr);
									}
								}
							}
						}
					} catch (e) {
						console.error('Error during duplicate-question fallback check (option):', e);
					}

				// Save AI messages returned
				const aiMessages = [];
				for (let i = 0; i < (aiResponse.messages || []).length; i++) {
					const aiMsg = aiResponse.messages[i];
					
					// 🔧 FIX: If this is the LAST message and there's a user_correction with options, add those options to this message
					const isLastMessage = (i === (aiResponse.messages || []).length - 1);
					const optionsToUse = isLastMessage && aiResponse.user_correction?.options 
						? aiResponse.user_correction.options 
						: (aiMsg.options || []);
					
					const savedAiMessage = await prisma.admin_chat.create({
						data: {
							user_id: user_id,
							sender: 'ai',
							message: aiMsg.message,
							message_type: aiMsg.message_type || 'text',
							options: optionsToUse,
							diff_html: null,
							emoji: aiMsg.emoji || null,
							images: aiMsg.images || [],
							videos: aiMsg.videos || [],
							links: aiMsg.links || []
						},
						select: {
							id: true, sender: true, message: true, message_type: true, options: true, diff_html: true, emoji: true, images: true, videos: true, links: true, created_at: true
						}
					});
					aiMessages.push(savedAiMessage);
					
					// 🔧 FIX: Link AI message to current goal so it appears in chat history
					if (finalCurrentGoal) {
						try {
							const existingLink = await prisma.chat_goal_progress.findFirst({
								where: {
									chat_id: savedAiMessage.id,
									goal_id: finalCurrentGoal.id,
									user_id: user_id
								}
							});

							if (!existingLink) {
								const goalProgress = await prisma.chat_goal_progress.findFirst({
									where: {
										user_id: user_id,
										goal_id: finalCurrentGoal.id
									}
								});

								if (!goalProgress) {
									await prisma.chat_goal_progress.create({
										data: {
											chat_id: savedAiMessage.id,
											goal_id: finalCurrentGoal.id,
											user_id: user_id,
											is_completed: false,
											num_questions: 0,
											num_correct: 0,
											num_incorrect: 0
										}
									});
								}
							}
						} catch (linkErr) {
							console.error('Error linking AI message to goal in option flow:', linkErr.message);
						}
					}
				}					// Also return updated goals so frontend can refresh the progress bar
					const updatedGoalsForClient = await prisma.topic_goals.findMany({
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

			// Refresh the userMessage object to reflect changes
			userMessage.diff_html = userCorrection.diff_html;
			userMessage.message = userCorrection.complete_answer || userMessage.message;
			userMessage.message_type = 'user_correction';
			userMessage.options = userCorrection.options || [];
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

		// Save AI messages (multiple bubbles) with message_type and options
		const aiMessages = []
		for (let i = 0; i < (aiResponse.messages || []).length; i++) {
			const aiMsg = aiResponse.messages[i];

			const savedAiMessage = await prisma.admin_chat.create({
				data: {
					user_id: user_id,
					sender: 'ai',
					message: aiMsg.message,
					message_type: aiMsg.message_type || 'text',
					options: aiMsg.options || [],
					diff_html: null,
					emoji: aiMsg.emoji || null,
					images: aiMsg.images || [],
					videos: aiMsg.videos || [],
					links: aiMsg.links || []
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
			})
			aiMessages.push(savedAiMessage)

			// Link AI message to current goal if it exists
			if (currentGoal) {
				try {
					const existingLink = await prisma.chat_goal_progress.findFirst({
						where: {
							chat_id: savedAiMessage.id,
							goal_id: currentGoal.id,
							user_id: user_id
						}
					})

					if (!existingLink) {
						const goalProgress = await prisma.chat_goal_progress.findFirst({
							where: {
								user_id: user_id,
								goal_id: currentGoal.id
							}
						})

						if (!goalProgress) {
							await prisma.chat_goal_progress.create({
								data: {
									chat_id: savedAiMessage.id,
									goal_id: currentGoal.id,
									user_id: user_id,
									is_completed: false,
									num_questions: 0,
									num_correct: 0,
									num_incorrect: 0
								}
							})
						}
					}
				} catch (linkErr) {
					console.error('Error linking AI message to goal:', linkErr.message)
				}
			}
		}

		// Update goal progress if user_correction feedback is provided
		let completedGoalsCount = 0 // Track for session end detection
		let totalGoalsCount = topicGoals.length // Track total goals
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
					error_subtype: null, // Could be extracted from more detailed feedback
					is_correct: isCorrectAnswer,
					score_percent: userCorrection.feedback.score_percent || (isCorrectAnswer ? 100 : 0),
					response_time_sec: 0, // Could be tracked by frontend and sent
					help_requested: null, // Could be tracked if user explicitly asks for help
					explain_loop_count: 0, // Will be incremented when user clicks "Explain"
					num_retries: 0, // Could track if same question is asked again
					goal_progress_before: progressBefore,
					goal_progress_after: progressAfter,
					mastery_score: masteryScore,
					difficulty_level: 'medium', // Could be dynamically determined
					topic_title: topic.title,
					subject_name: topic.subject_id_rel?.name || null,
					question_type: 'open_ended'
				});

				console.log('✅ Learning turn record created successfully');
			} catch (learningTurnError) {
				console.error('❌ Failed to create learning turn record:', learningTurnError);
				// Don't fail the request if learning turn creation fails
			}

			if (existingProgress) {
				// Update existing progress
				const newNumQuestions = existingProgress.num_questions + (isActualAnswer ? 1 : 0)
				const newNumCorrect = existingProgress.num_correct + (isCorrectAnswer ? 1 : 0)
				const newNumIncorrect = existingProgress.num_incorrect + (isActualAnswer && !isCorrectAnswer ? 1 : 0)
				
				// Calculate accuracy
				const accuracyPercent = newNumQuestions > 0 ? Math.round((newNumCorrect / newNumQuestions) * 100) : 0
				
				// ALL goals need 2 questions to complete
				const requiredQuestions = 2
				const shouldComplete = newNumQuestions >= requiredQuestions

				await prisma.chat_goal_progress.update({
					where: { id: existingProgress.id },
					data: {
						num_questions: newNumQuestions,
						num_correct: newNumCorrect,
						num_incorrect: newNumIncorrect,
						is_completed: shouldComplete,
						last_question_id: newChatProcess.id,
						updated_at: new Date()
					}
				})

				console.log(`📊 Goal Progress Updated | Goal: ${currentGoal.title} | Questions: ${newNumQuestions} | Correct: ${newNumCorrect} | Accuracy: ${accuracyPercent}% | Completed: ${shouldComplete}`)
			} else {
				// This shouldn't happen if we created the link earlier, but handle it
				const numQuestions = isActualAnswer ? 1 : 0
				const numCorrect = isCorrectAnswer ? 1 : 0
				const numIncorrect = (isActualAnswer && !isCorrectAnswer) ? 1 : 0
				
				// ALL goals need 2 questions to complete
				const requiredQuestions = 2
				const shouldComplete = numQuestions >= requiredQuestions
				
				await prisma.chat_goal_progress.upsert({
					where: {
						chat_id_goal_id_user_id: {
							chat_id: userMessage.id,
							goal_id: currentGoal.id,
							user_id: user_id
						}
					},
					update: {
						num_questions: { increment: numQuestions },
						num_correct: { increment: numCorrect },
						num_incorrect: { increment: numIncorrect },
						is_completed: shouldComplete,
						last_question_id: newChatProcess.id
					},
					create: {
						chat_id: userMessage.id,
						goal_id: currentGoal.id,
						user_id: user_id,
						is_completed: shouldComplete,
						num_questions: numQuestions,
						num_correct: numCorrect,
						num_incorrect: numIncorrect,
						last_question_id: newChatProcess.id
					}
				})

				const accuracyPercent = numQuestions > 0 ? (isCorrectAnswer ? 100 : 0) : 0
				console.log(`📊 Goal Progress Created | Goal: ${currentGoal.title} | Questions: ${numQuestions} | Correct: ${numCorrect} | Accuracy: ${accuracyPercent}% | Completed: ${shouldComplete}`)
			}

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

			await prisma.topics.update({
				where: { id: parseInt(topicId) },
				data: {
					completion_percent: completionPercent,
					is_completed: completionPercent >= 50
				}
			})

			console.log(`🎯 Topic Progress | Completed Goals: ${completedGoalsCount}/${totalGoalsCount} | Completion: ${completionPercent}%`)
			
			// 🔧 FIX: Re-fetch goals with UPDATED progress so subsequent AI calls see correct completion status
			const updatedGoalsAfterProgress = await prisma.topic_goals.findMany({
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
			
			// 🔥 AUTO-GENERATE SESSION SUMMARY: If ALL goals are now complete, automatically show session summary
			if (completedGoalsCount >= totalGoalsCount && !currentGoal) {
				console.log('\n🎉 ALL GOALS COMPLETED! Auto-generating session summary...\n')
				
				try {
					// Generate session summary with updated goals
					const summaryResponse = await generateTopicChatResponse(
						'', // Empty message triggers session summary
						topic.title,
						topic.content || 'No additional content provided',
						chatHistory,
						null, // No current goal - all complete
						updatedGoalsAfterProgress,
						user_id,
						parseInt(topicId)
					)
					
					// Save session summary message
					if (summaryResponse && summaryResponse.messages) {
						for (const summaryMsg of summaryResponse.messages) {
							// Store session_metrics in the message for frontend to parse
							const messageData = {
								user_id: user_id,
								sender: 'ai',
								message: summaryMsg.formatted_summary || summaryMsg.message || 'session_complete',
								message_type: summaryMsg.message_type || 'session_summary',
								options: summaryMsg.options || ['End Session', 'Learn More'],
								diff_html: JSON.stringify(summaryMsg.session_metrics || {}), // Store metrics in diff_html as JSON
								emoji: summaryMsg.emoji || '🎉',
								images: summaryMsg.images || [],
								videos: summaryMsg.videos || [],
								links: summaryMsg.links || []
							}
							
							const savedSummaryMessage = await prisma.admin_chat.create({
								data: messageData,
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
							
							// Add to aiMessages array so it's returned to frontend
							aiMessages.push(savedSummaryMessage)
							console.log('✅ Session summary message saved and added to response')
						}
					}
				} catch (summaryError) {
					console.error('Error generating session summary:', summaryError)
				}
			}
		}

		// Update user's chat count
		await prisma.users.update({
			where: { user_id: user_id },
			data: { num_chats: { increment: 1 } }
		})

		// Update topic time spent if provided
		if (session_time_seconds && session_time_seconds > 0) {
			await prisma.topics.update({
				where: { id: parseInt(topicId) },
				data: {
					time_spent_seconds: {
						increment: Math.floor(session_time_seconds)
					}
				}
			})
		}

		return res.status(201).json({
			userMessage,
			aiMessages,
			feedback: aiResponse.feedback || (userCorrection?.feedback) || null,
			userCorrection: userCorrection || null,
			session_summary: aiResponse.session_summary || null,
			all_goals_completed: completedGoalsCount >= totalGoalsCount // Add flag for frontend
		})
	} catch (err) {
		console.error('Error sending topic chat message:', err)
		return res.status(500).json({ error: 'Server error while sending message' })
	}
})

// POST /api/topic-chats/:topicId/update-time
// Update time spent on topic without sending a message
router.post('/:topicId/update-time', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { topicId } = req.params
	const { session_time_seconds } = req.body

	// For production, always require authenticated user
	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!topicId || isNaN(parseInt(topicId))) {
		return res.status(400).json({ error: 'Valid topic ID is required' })
	}

	if (!session_time_seconds || session_time_seconds <= 0) {
		return res.status(400).json({ error: 'Valid session time is required' })
	}

	try {
		// Verify user has access to this topic
		const topic = await prisma.topics.findFirst({
			where: {
				id: parseInt(topicId),
				user_id: user_id
			}
		})

		if (!topic) {
			return res.status(403).json({ error: 'Topic not found or user does not have access' })
		}

		// Update topic time spent
		await prisma.topics.update({
			where: { id: parseInt(topicId) },
			data: {
				time_spent_seconds: {
					increment: Math.floor(session_time_seconds)
				}
			}
		})

		return res.status(200).json({ success: true })
	} catch (err) {
		console.error('Error updating topic time:', err)
		return res.status(500).json({ error: 'Server error while updating time' })
	}
})

// POST /api/topic-chats/:topicId/learn-more
// Start or continue "Learn More" session after completing all goals
router.post('/:topicId/learn-more', authenticateToken, async (req, res) => {
	let user_id = req.user?.user_id
	const { topicId } = req.params
	const { message, is_initial } = req.body

	if (!user_id) {
		return res.status(401).json({ error: 'Authentication required - please login' })
	}

	if (!topicId || isNaN(parseInt(topicId))) {
		return res.status(400).json({ error: 'Valid topic ID is required' })
	}

	try {
		const { calculateSessionMetrics } = require('../../services/topic_chat_metrics')
		const { 
			analyzeMistakesForLearnMore, 
			generateLearnMoreGreeting, 
			generateLearnMoreResponse 
		} = require('../../services/topic_chat_learn_more')

		console.log('\n========== LEARN MORE REQUEST ==========');
		console.log('👤 User:', user_id);
		console.log('📚 Topic ID:', topicId);
		console.log('💬 Message:', message || 'Initial greeting');
		console.log('🆕 Is Initial:', is_initial);

		// Verify topic access
		const topic = await prisma.topics.findFirst({
			where: {
				id: parseInt(topicId),
				user_id: user_id
			}
		})

		if (!topic) {
			return res.status(403).json({ error: 'Topic not found or access denied' })
		}

		// Fetch topic goals with progress
		const topicGoals = await prisma.topic_goals.findMany({
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

		// Calculate session metrics to identify weak areas
		const sessionMetrics = await calculateSessionMetrics(user_id, parseInt(topicId), topicGoals)

		// If no weak areas, don't start Learn More
		if (!sessionMetrics.has_weak_areas) {
			return res.status(200).json({
				message: 'Great job! You mastered all areas - no Learn More needed!',
				can_learn_more: false
			})
		}

		// Analyze mistakes for learning plan
		const learningPlan = analyzeMistakesForLearnMore(
			sessionMetrics.weak_goals,
			sessionMetrics.all_mistakes,
			sessionMetrics.error_type_counts
		)

		// Get current focus area (first weak goal to work on)
		const currentFocusArea = learningPlan.focus_areas[0]

		let response
		if (is_initial) {
			// Generate initial greeting for Learn More mode
			response = await generateLearnMoreGreeting(topic.title, learningPlan)
		} else {
			// Get chat history for Learn More mode
			const goalIds = topicGoals.map(g => g.id)
			const recentMessages = await prisma.admin_chat.findMany({
				where: {
					chat_goal_progress: {
						some: {
							goal_id: { in: goalIds },
							user_id: user_id
						}
					}
				},
				orderBy: {
					created_at: 'desc'
				},
				take: 10,
				select: {
					sender: true,
					message: true,
					message_type: true
				}
			})

			const chatHistory = recentMessages.reverse()

			// Extract questions asked in Learn More mode (from chat after session completion)
			const questionsAskedInLearnMore = chatHistory
				.filter(m => m.sender === 'ai' && m.message && m.message.includes('?'))
				.map(m => m.message)

			// Generate Learn More response
			response = await generateLearnMoreResponse(
				message,
				topic.title,
				topic.content || '',
				learningPlan,
				currentFocusArea,
				chatHistory,
				questionsAskedInLearnMore
			)
		}

		// Store Learn More messages in admin_chat
		if (response && response.messages && response.messages.length > 0) {
			for (const msg of response.messages) {
				const newMsg = await prisma.admin_chat.create({
					data: {
						user_id: user_id,
						sender: 'ai',
						message: msg.message || '',
						message_type: msg.message_type || 'text',
						options: msg.options || [],
						images: [],
						videos: [],
						links: []
					}
				})

				// Link to current focus goal
				if (currentFocusArea) {
					await prisma.chat_goal_progress.upsert({
						where: {
							chat_id_goal_id_user_id: {
								chat_id: newMsg.id,
								goal_id: currentFocusArea.goal_id,
								user_id: user_id
							}
						},
						create: {
							chat_id: newMsg.id,
							goal_id: currentFocusArea.goal_id,
							user_id: user_id,
							is_completed: false,
							num_questions: 0,
							num_correct: 0,
							num_incorrect: 0
						},
						update: {}
					})
				}
			}
		}

		// If response has user_correction, store that too
		if (response && response.user_correction) {
			// Store user correction in admin_chat as special message type
			const correctionMsg = await prisma.admin_chat.create({
				data: {
					user_id: user_id,
					sender: 'ai',
					message: response.user_correction.complete_answer || '',
					message_type: 'user_correction',
					diff_html: response.user_correction.diff_html || '',
					options: response.user_correction.options || [],
					emoji: response.user_correction.emoji || '',
					images: [],
					videos: [],
					links: []
				}
			})

			// Link to current focus goal
			if (currentFocusArea) {
				await prisma.chat_goal_progress.upsert({
					where: {
						chat_id_goal_id_user_id: {
							chat_id: correctionMsg.id,
							goal_id: currentFocusArea.goal_id,
							user_id: user_id
						}
					},
					create: {
						chat_id: correctionMsg.id,
						goal_id: currentFocusArea.goal_id,
						user_id: user_id,
						is_completed: false,
						num_questions: 0,
						num_correct: 0,
						num_incorrect: 0
					},
					update: {}
				})
			}
		}

		console.log('✅ Learn More response generated and stored');
		console.log('==========================================\n');

		return res.status(200).json({
			response: response,
			learning_plan: learningPlan,
			current_focus_area: currentFocusArea,
			can_learn_more: true
		})
	} catch (err) {
		console.error('Error in Learn More mode:', err)
		return res.status(500).json({ error: 'Server error in Learn More mode' })
	}
})

module.exports = router

