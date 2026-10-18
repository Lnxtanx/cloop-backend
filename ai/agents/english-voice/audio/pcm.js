/**
 * English Voice-to-Voice — PCM audio utilities
 *
 * Pure helpers for the conversation recording pipeline:
 *   mic (16kHz PCM16 base64) + Gemini Live output (24kHz PCM16 base64)
 *   → single mixed 16kHz PCM16 track for S3 upload.
 */

const TARGET_RECORD_RATE = 16000

function parsePcmRate(mimeType, fallback = TARGET_RECORD_RATE) {
	const match = /rate=(\d+)/i.exec(String(mimeType || ''))
	return match ? parseInt(match[1], 10) : fallback
}

function resamplePcm16(pcmBuffer, fromRate, toRate) {
	if (!pcmBuffer || pcmBuffer.length < 2 || fromRate === toRate) return pcmBuffer
	const inSamples = Math.floor(pcmBuffer.length / 2)
	const ratio = fromRate / toRate
	const outSamples = Math.max(1, Math.floor(inSamples / ratio))
	const out = Buffer.alloc(outSamples * 2)
	for (let i = 0; i < outSamples; i++) {
		const srcPos = i * ratio
		const i0 = Math.floor(srcPos)
		const i1 = Math.min(i0 + 1, inSamples - 1)
		const frac = srcPos - i0
		const s0 = pcmBuffer.readInt16LE(i0 * 2)
		const s1 = pcmBuffer.readInt16LE(i1 * 2)
		let s = Math.round(s0 + (s1 - s0) * frac)
		if (s > 32767) s = 32767
		else if (s < -32768) s = -32768
		out.writeInt16LE(s, i * 2)
	}
	return out
}

const AI_BURST_GAP_MS = 250

function buildConversationPcm(audioChunks, targetRate = TARGET_RECORD_RATE) {
	if (!audioChunks || audioChunks.length === 0) return Buffer.alloc(0)

	let startTs = Infinity
	for (const chunk of audioChunks) {
		if (chunk.ts < startTs) startTs = chunk.ts
	}

	const bySource = { user: [], ai: [] }
	for (const chunk of audioChunks) {
		if (!chunk.data || chunk.data.length < 2) continue
		const source = chunk.source === 'ai' ? 'ai' : 'user'
		bySource[source].push(chunk)
	}

	const prepared = []
	let endMs = 0

	// Place each source on its own playhead:
	// - Gemini often delivers AI audio in faster-than-realtime bursts with nearly
	//   identical Date.now() values. Chaining by duration keeps those words sequential.
	// - A wall-clock gap > AI_BURST_GAP_MS is a real pause between turns and is kept.
	// - User mic is real-time, so this is a no-op for normal mic capture.
	for (const source of ['user', 'ai']) {
		const list = bySource[source]
		if (!list.length) continue

		list.sort((a, b) => (a.ts - b.ts) || ((a.seq || 0) - (b.seq || 0)))

		let playheadMs = null
		for (const chunk of list) {
			const pcm = resamplePcm16(chunk.data, chunk.rate || targetRate, targetRate)
			const samples = Math.floor(pcm.length / 2)
			if (samples <= 0) continue
			const durMs = (samples / targetRate) * 1000
			const wallMs = Math.max(0, chunk.ts - startTs)

			let offsetMs
			if (playheadMs === null) {
				offsetMs = wallMs
			} else if (wallMs > playheadMs + AI_BURST_GAP_MS) {
				offsetMs = wallMs
			} else {
				offsetMs = playheadMs
			}

			playheadMs = offsetMs + durMs
			if (playheadMs > endMs) endMs = playheadMs
			prepared.push({ pcm, offsetMs, samples })
		}
	}

	if (prepared.length === 0) return Buffer.alloc(0)

	const totalSamples = Math.ceil((endMs / 1000) * targetRate) + targetRate
	const out = Buffer.alloc(totalSamples * 2)

	for (const { pcm, offsetMs, samples } of prepared) {
		const startSample = Math.round((offsetMs / 1000) * targetRate)
		for (let i = 0; i < samples; i++) {
			const idx = startSample + i
			if (idx < 0 || idx >= totalSamples) continue
			const existing = out.readInt16LE(idx * 2)
			const incoming = pcm.readInt16LE(i * 2)
			let mixed = existing + incoming
			if (mixed > 32767) mixed = 32767
			else if (mixed < -32768) mixed = -32768
			out.writeInt16LE(mixed, idx * 2)
		}
	}

	return out
}

module.exports = {
	TARGET_RECORD_RATE,
	AI_BURST_GAP_MS,
	parsePcmRate,
	resamplePcm16,
	buildConversationPcm,
}
