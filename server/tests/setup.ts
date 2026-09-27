import 'dotenv/config';

// Point the app at the isolated test database before any app module loads.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
