require('dotenv').config()
const { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3')
const s3Storage = require('./services/s3-storage')

async function runS3Test() {
  console.log('====================================================')
  console.log('🧪 Testing AWS S3 Bucket Reachability & Configuration')
  console.log('====================================================')

  const bucket = process.env.AWS_S3_BUCKET_NAME
  const region = process.env.AWS_REGION || 'ap-south-1'
  const key = process.env.AWS_ACCESS_KEY_ID
  const secret = process.env.AWS_SECRET_ACCESS_KEY

  console.log(`Bucket Name: ${bucket ? bucket : '❌ NOT SET'}`)
  console.log(`Region:      ${region}`)
  console.log(`Access Key:  ${key ? key.substring(0, 4) + '...' + key.substring(key.length - 4) : '❌ NOT SET'}`)
  console.log(`Secret Key:  ${secret ? '********' + secret.substring(secret.length - 4) : '❌ NOT SET'}`)

  if (!bucket || !key || !secret) {
    console.error('\n❌ Missing required S3 configuration in .env!')
    console.error('Please ensure AWS_S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are set.')
    process.exit(1)
  }

  const client = new S3Client({
    region: region.trim(),
    credentials: {
      accessKeyId: key.trim(),
      secretAccessKey: secret.trim(),
    },
  })

  // Test 1: Bucket Reachability (HeadBucket)
  console.log(`\n🔍 Step 1: Checking reachability of bucket "${bucket}"...`)
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket.trim() }))
    console.log(`✅ Bucket "${bucket}" is REACHABLE and accessible!`)
  } catch (err) {
    console.warn(`⚠️ HeadBucket returned: ${err.name || err.code} (${err.message})`)
    if (err.$metadata?.httpStatusCode === 403) {
      console.log('ℹ️ Notice: HeadBucket returned 403 Forbidden. This is normal if IAM policy does not include s3:ListBucket, testing PutObject directly...')
    } else if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') {
      console.error(`❌ Bucket "${bucket}" does not exist in region "${region}"!`)
      process.exit(1)
    }
  }

  // Test 2: Upload a Test Audio File
  console.log('\n🔍 Step 2: Testing audio upload to S3...')
  const testPcmBuffer = Buffer.alloc(32000, 0) // 1 second of silent 16kHz PCM16 audio
  const testSessionId = 99999
  const testUserId = 98

  try {
    const audioUrl = await s3Storage.uploadSessionAudio({
      sessionId: testSessionId,
      userId: testUserId,
      pcmBuffer: testPcmBuffer,
      trackKey: 's3_diagnostic_test',
      chapterKey: 'reachability_check',
    })

    if (audioUrl) {
      console.log(`✅ Audio upload test PASSED!`)
      console.log(`🔗 Generated Audio URL: ${audioUrl}`)

      // Test 3: Generate Presigned URL & Verify HTTP Retrieval
      console.log('\n🔍 Step 3: Testing Presigned Audio URL retrieval...')
      const presignedUrl = await s3Storage.getPresignedAudioUrl(audioUrl, 3600)
      console.log(`🔑 Presigned URL: ${presignedUrl.substring(0, 80)}...`)

      const fetchRes = await fetch(presignedUrl)
      console.log(`📡 Presigned URL HTTP Status: ${fetchRes.status} ${fetchRes.statusText}`)
      if (fetchRes.ok) {
        const arrayBuf = await fetchRes.arrayBuffer()
        console.log(`✅ Successfully downloaded audio via presigned URL! Size: ${arrayBuf.byteLength} bytes`)
      } else {
        console.warn(`⚠️ Fetching via presigned URL returned status ${fetchRes.status}`)
      }
    } else {
      console.error('❌ Audio upload returned null. Check s3-storage logs above.')
      process.exit(1)
    }
  } catch (err) {
    console.error('❌ Failed to upload audio file to S3:', err)
    process.exit(1)
  }

  console.log('\n====================================================')
  console.log('🎉 S3 BUCKET TEST COMPLETED SUCCESSFULLY!')
  console.log('====================================================')
}

runS3Test().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
