-- Migration: Create feedback table
-- Run this SQL to add feedback functionality

CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5) NOT NULL,
  feedback TEXT NOT NULL,
  category VARCHAR(50) DEFAULT 'general',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for faster queries by user
CREATE INDEX idx_feedback_user_id ON feedback(user_id);

-- Index for sorting by date
CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);

-- Grant permissions (adjust as needed for your setup)
-- GRANT ALL PRIVILEGES ON feedback TO your_user;
-- GRANT USAGE, SELECT ON SEQUENCE feedback_id_seq TO your_user;
