/**
 * Batch Global Curriculum Generator CLI
 * 
 * Uses the existing Tavily Web Search + DeepSeek AI pipeline to generate
 * global curriculum (chapters -> topics -> goals) for existing boards and grades (Class 5 to 10).
 * 
 * Usage Examples:
 *   # Generate a single subject for CBSE Class 10:
 *   node scripts/generate-global-curriculum.js --board CBSE --grade "Class 10" --subject Mathematics
 * 
 *   # Generate all subjects for CBSE Class 10:
 *   node scripts/generate-global-curriculum.js --board CBSE --grade "Class 10"
 * 
 *   # Generate all subjects for all classes (Class 5 to 10) for CBSE:
 *   node scripts/generate-global-curriculum.js --board CBSE
 * 
 *   # Generate all existing boards and classes:
 *   node scripts/generate-global-curriculum.js --all
 */

require('dotenv').config();
const prisma = require('../lib/prisma');
const { ensureGlobalCurriculum } = require('../services/global-curriculum-pipeline');
const pLimitModule = require('p-limit');
const pLimit = pLimitModule.default || pLimitModule;

// Standard Curriculum Matrix for Existing Boards & Classes
const DEFAULT_GRADES = [
	'Class 5',
	'Class 6',
	'Class 7',
	'Class 8',
	'Class 9',
	'Class 10'
];

const DEFAULT_SUBJECTS_BY_GRADE = {
	'Class 5': ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science', 'Art & Craft'],
	'Class 6': ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science'],
	'Class 7': ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science'],
	'Class 8': ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Environmental Studies', 'Computer Science'],
	'Class 9': ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science'],
	'Class 10': ['Mathematics', 'Science', 'Social Studies', 'English', 'Hindi', 'Computer Science']
};

const DEFAULT_BOARDS = [
	{ code: 'CBSE', name: 'Central Board of Secondary Education' },
	{ code: 'ICSE', name: 'Indian Certificate of Secondary Education' }
];

function parseArgs() {
	const args = process.argv.slice(2);
	const options = {
		board: null,
		grade: null,
		subject: null,
		all: false,
		concurrency: 2,
		force: false
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--board' && args[i + 1]) {
			options.board = args[++i];
		} else if (arg === '--grade' && args[i + 1]) {
			options.grade = args[++i];
		} else if (arg === '--subject' && args[i + 1]) {
			options.subject = args[++i];
		} else if (arg === '--all') {
			options.all = true;
		} else if (arg === '--concurrency' && args[i + 1]) {
			options.concurrency = parseInt(args[++i], 10) || 2;
		} else if (arg === '--force') {
			options.force = true;
		}
	}

	return options;
}

async function main() {
	const options = parseArgs();

	console.log('\n======================================================');
	console.log('🚀 Cloop Global Curriculum Batch Generator');
	console.log('======================================================');

	// Determine boards to process
	let targetBoards = DEFAULT_BOARDS;
	if (options.board) {
		const matchedBoard = DEFAULT_BOARDS.find(
			b => b.code.toLowerCase() === options.board.toLowerCase() ||
			     b.name.toLowerCase().includes(options.board.toLowerCase())
		);
		targetBoards = matchedBoard ? [matchedBoard] : [{ code: options.board, name: options.board }];
	}

	// Determine grades to process
	let targetGrades = DEFAULT_GRADES;
	if (options.grade) {
		const formattedGrade = options.grade.toLowerCase().startsWith('class')
			? options.grade
			: `Class ${options.grade.replace(/\D/g, '')}`;
		targetGrades = [formattedGrade];
	}

	// Build list of tasks
	const tasks = [];

	for (const boardObj of targetBoards) {
		const boardName = boardObj.name;

		for (const grade of targetGrades) {
			const subjects = options.subject
				? [options.subject]
				: (DEFAULT_SUBJECTS_BY_GRADE[grade] || DEFAULT_SUBJECTS_BY_GRADE['Class 10']);

			for (const subjectName of subjects) {
				tasks.push({
					board: boardName,
					grade: grade,
					subject: subjectName
				});
			}
		}
	}

	console.log(`📋 Total Curriculum Tasks Queued: ${tasks.length}`);
	console.log(`⚡ Concurrency Level: ${options.concurrency}`);
	console.log('======================================================\n');

	const limit = pLimit(options.concurrency);
	const results = {
		successful: 0,
		alreadyExisted: 0,
		failed: 0,
		details: []
	};

	const startTime = Date.now();

	const taskPromises = tasks.map((task, index) => {
		return limit(async () => {
			const taskLabel = `[${index + 1}/${tasks.length}] ${task.board} | ${task.grade} | ${task.subject}`;
			console.log(`\n⏳ Starting: ${taskLabel}`);

			try {
				const result = await ensureGlobalCurriculum(
					task.board,
					task.grade,
					task.subject
				);

				if (result && result.alreadyExisted) {
					console.log(`⏩ [Skipped] Already generated: ${taskLabel}`);
					results.alreadyExisted++;
					results.details.push({ ...task, status: 'EXISTS', id: result.globalSubject?.id });
				} else if (result && result.globalSubject) {
					console.log(`✅ [Success] Generated: ${taskLabel} (ID: ${result.globalSubject.id})`);
					results.successful++;
					results.details.push({ ...task, status: 'GENERATED', id: result.globalSubject.id });
				} else {
					console.log(`⚠️ [Incomplete] ${taskLabel}`);
					results.failed++;
					results.details.push({ ...task, status: 'INCOMPLETE' });
				}

				// Small breath between tasks to respect API pacing
				await new Promise(resolve => setTimeout(resolve, 1500));
			} catch (error) {
				console.error(`❌ [Failed] ${taskLabel}:`, error.message);
				results.failed++;
				results.details.push({ ...task, status: 'FAILED', error: error.message });
			}
		});
	});

	await Promise.all(taskPromises);

	const durationSec = Math.round((Date.now() - startTime) / 1000);

	console.log('\n======================================================');
	console.log('📊 CURRICULUM GENERATION SUMMARY');
	console.log('======================================================');
	console.log(`⏱️  Total Duration: ${durationSec}s`);
	console.log(`✅ Newly Generated: ${results.successful}`);
	console.log(`⏩ Already Existed: ${results.alreadyExisted}`);
	console.log(`❌ Failed:          ${results.failed}`);
	console.log(`📚 Total Processed: ${tasks.length}`);
	console.log('======================================================\n');
}

main()
	.catch(err => {
		console.error('Fatal batch generator error:', err);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
