process.env.NODE_ENV = 'test';
process.env.JOBS_ENABLED = 'false';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://soms:soms@localhost:5432/soms_test';
process.env.COLLEGE_EMAIL_DOMAINS =
  process.env.COLLEGE_EMAIL_DOMAINS || 'skyline.ac.in,test.skyline.ac.in';
process.env.COLLEGE_VERIFICATION_MODE = 'mock';
process.env.NOTIFY_MODE = 'dev';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX || '30';
process.env.UPLOAD_DIR = process.env.TEST_UPLOAD_DIR || '/tmp/soms-test-uploads';
process.env.DEV_TOOLS_ENABLED = 'true';
