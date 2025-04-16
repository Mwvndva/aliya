require('dotenv').config();
const { Pool } = require('pg');
const logger = require('winston');

// Database Configuration
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '3001'),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 20,
});

pool.on('error', (err) => {
  logger.error('Database pool error:', err);
});

// Table Schemas
const TABLE_SCHEMAS = `
  CREATE TABLE IF NOT EXISTS users (
    phone VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    age INTEGER CHECK (age > 0 AND age < 120),
    sex VARCHAR(10) CHECK (sex IN ('male', 'female', 'other')),
    height FLOAT CHECK (height > 50 AND height < 300),
    weight FLOAT CHECK (weight > 20 AND weight < 300),
    medical_history TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS health_assessments (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) REFERENCES users(phone) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
    lifestyle_data JSONB NOT NULL,
    recommendations TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS diagnoses (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) REFERENCES users(phone) ON DELETE CASCADE,
    symptoms TEXT NOT NULL,
    possible_conditions TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS fitness_logs (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) REFERENCES users(phone) ON DELETE CASCADE,
    workout_plan JSONB NOT NULL,
    progress JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meal_plans (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) REFERENCES users(phone) ON DELETE CASCADE,
    dietary_preferences JSONB NOT NULL,
    meals JSONB NOT NULL,
    grocery_list TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cycle_data (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) REFERENCES users(phone) ON DELETE CASCADE,
    cycle_logs JSONB NOT NULL,
    predictions JSONB NOT NULL,
    symptoms TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

// Helper Functions
function calculateNextPeriod(lastPeriod, cycleLength) {
  const date = new Date(lastPeriod);
  date.setDate(date.getDate() + parseInt(cycleLength));
  return date.toISOString();
}

function calculateFertileWindow(lastPeriod, cycleLength) {
  const ovulationDate = new Date(lastPeriod);
  ovulationDate.setDate(ovulationDate.getDate() + parseInt(cycleLength) - 14);
  
  return {
    start: new Date(ovulationDate.setDate(ovulationDate.getDate() - 5)).toISOString(),
    end: new Date(ovulationDate.setDate(ovulationDate.getDate() + 6)).toISOString()
  };
}

// User Operations
async function getUserProfile(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM users WHERE phone = $1', 
      [phone]
    );
    return result.rows[0];
  } catch (err) {
    logger.error(`Error getting user profile: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function saveUserProfile(phone, profile) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO users (phone, name, age, sex, height, weight, medical_history)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (phone) DO UPDATE
       SET name = $2, age = $3, sex = $4, height = $5, weight = $6, medical_history = $7, updated_at = CURRENT_TIMESTAMP`,
      [phone, profile.name, profile.age, profile.sex, profile.height, profile.weight, profile.medical_history]
    );
  } catch (err) {
    logger.error(`Error saving user profile: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Health Assessment Operations
async function saveHealthAssessment(phone, data) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO health_assessments (phone, score, lifestyle_data, recommendations)
       VALUES ($1, $2, $3, $4)`,
      [phone, data.score, data.lifestyle_data, data.recommendations]
    );
  } catch (err) {
    logger.error(`Error saving health assessment: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function getLatestHealthAssessment(phone) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM health_assessments 
       WHERE phone = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [phone]
    );
    return result.rows[0];
  } catch (err) {
    logger.error(`Error getting health assessment: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Diagnosis Operations
async function saveDiagnosis(phone, symptoms, conditions) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO diagnoses (phone, symptoms, possible_conditions)
       VALUES ($1, $2, $3)`,
      [phone, symptoms, conditions]
    );
  } catch (err) {
    logger.error(`Error saving diagnosis: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Fitness Plan Operations
async function saveFitnessPlan(phone, planData) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO fitness_logs (phone, workout_plan)
       VALUES ($1, $2)`,
      [phone, JSON.stringify(planData)]
    );
  } catch (err) {
    logger.error(`Error saving fitness plan: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Meal Plan Operations
async function saveMealPlan(phone, planData) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO meal_plans (phone, dietary_preferences, meals, grocery_list)
       VALUES ($1, $2, $3, $4)`,
      [
        phone,
        JSON.stringify({
          preferences: planData.preferences,
          allergies: planData.allergies,
          frequency: planData.frequency
        }),
        JSON.stringify(generateSampleMeals(planData)),
        generateGroceryList(planData)
      ]
    );
  } catch (err) {
    logger.error(`Error saving meal plan: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Cycle Tracking Operations
async function saveCycleData(phone, cycleData) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO cycle_data (phone, cycle_logs, predictions)
       VALUES ($1, $2, $3)`,
      [
        phone,
        JSON.stringify({
          lastPeriod: cycleData.lastPeriod,
          cycleLength: cycleData.cycleLength
        }),
        JSON.stringify({
          nextPeriod: calculateNextPeriod(cycleData.lastPeriod, cycleData.cycleLength),
          fertileWindow: calculateFertileWindow(cycleData.lastPeriod, cycleData.cycleLength)
        })
      ]
    );
  } catch (err) {
    logger.error(`Error saving cycle data: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Database Initialization
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(TABLE_SCHEMAS);
    logger.info('Database tables initialized');
  } catch (err) {
    logger.error(`Database initialization failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function testConnection() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    logger.info('Database connection successful');
  } catch (err) {
    logger.error(`Database connection test failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

// Helper Functions
function generateSampleMeals(planData) {
  // ... implementation ...
}

function generateGroceryList(planData) {
  // ... implementation ...
}

// Initialize with retries
async function initializeWithRetries(maxAttempts = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initializeDatabase();
      await testConnection();
      logger.info('Database ready');
      return;
    } catch (err) {
      logger.error(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxAttempts) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Export all functions
module.exports = {
  initializeDatabase,
  getUserProfile,
  saveUserProfile,
  getLatestHealthAssessment,
  saveHealthAssessment,
  saveDiagnosis,
  saveFitnessPlan,
  saveMealPlan,
  saveCycleData
};