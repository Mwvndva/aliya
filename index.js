const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const logger = require('winston');
const dotenv = require('dotenv');

// Fixed imports - using module.exports pattern
const db = require('./db');
const cohere = require('./cohere');

// Load environment variables
dotenv.config();

// Configure logging
logger.configure({
  transports: [
    new logger.transports.File({ filename: 'error.log', level: 'error' }),
    new logger.transports.File({ filename: 'combined.log' }),
    new logger.transports.Console({ format: logger.format.simple() })
  ],
});

// Initialize Express
const app = express();
app.use(express.json());

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { 
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// State management (unchanged)
const stateManager = {
  states: new Map(),
  reminders: new Map(),

  setState(phone, state) {
    this.states.set(phone, { ...this.states.get(phone), ...state });
    logger.info(`State updated for ${phone}: ${JSON.stringify(state)}`);
  },

  getState(phone) {
    return this.states.get(phone) || {};
  },

  setReminder(phone, timeout) {
    this.clearReminder(phone);
    this.reminders.set(phone, timeout);
  },

  clearReminder(phone) {
    const timeout = this.reminders.get(phone);
    if (timeout) clearTimeout(timeout);
    this.reminders.delete(phone);
  },

  cleanup(phone) {
    this.states.delete(phone);
    this.clearReminder(phone);
    logger.info(`State cleaned up for ${phone}`);
  },
};

// Constants (unchanged)
const TERMS_AND_CONDITIONS = `
📜 *Terms and Disclaimer* 📜

1. I am an AI health assistant, not a doctor.
2. My advice should not replace professional medical care.
3. Your data will be stored securely and used only for your health recommendations.
4. By using this service, you agree to these terms.

Do you accept these terms? (yes/no)
`;

const AVAILABLE_SERVICES = `
🩺 *Available Services*:

1. /diagnose [symptoms] - Check possible conditions
2. /fit - Start fitness program
3. /meals - Get meal plans
4. /cycle - Track menstrual cycle
5. /data - View your health data
6. /periodtips - Get menstrual health tips
7. /help - Show this menu

Type any command or ask general health questions.
`;

// Helper functions (unchanged)
function calculateBMI(height, weight) {
  return (weight / ((height / 100) ** 2)).toFixed(1);
}

function calculateHealthScore(data) {
  let score = 100;
  if (data.sleepHours < 7) score -= 10;
  if (data.waterIntake < 8) score -= 5;
  if (data.exerciseDays < 3) score -= 15;
  if (data.stressLevel > 7) score -= 10;
  if (data.dietQuality < 5) score -= 10;
  if (data.smokes === 'yes') score -= 20;
  if (data.alcoholDrinks > 7) score -= 5;
  return Math.max(0, score);
}

function getHealthRecommendations(score) {
  if (score >= 80) return "Excellent health! Maintain your habits.";
  if (score >= 60) return "Good health, but could improve in some areas.";
  return "Consider lifestyle changes. Focus on sleep, diet and exercise.";
}

function generateFitnessPlan(data) {
  let plan = `🏋️ *Fitness Plan for ${data.goals}*\n`;
  plan += `Frequency: ${data.frequency} days/week\n`;
  
  if (data.goals.toLowerCase().includes('weight loss')) {
    plan += "Cardio: 30-45 mins, 3-5x/week\n";
    plan += "Strength: Full body, 2-3x/week\n";
  } else if (data.goals.toLowerCase().includes('muscle gain')) {
    plan += "Strength: Split routine, 4-5x/week\n";
    plan += "Cardio: 20 mins, 2x/week\n";
  } else {
    plan += "Balanced: 3 days strength, 2 days cardio\n";
  }
  
  return plan;
}

function generateMealPlan(data) {
  let plan = `🍎 *Meal Plan (${data.preferences})*\n`;
  plan += `Meals per day: ${data.frequency}\n\n`;
  
  if (data.preferences.toLowerCase().includes('vegetarian')) {
    plan += "Breakfast: Oatmeal with nuts and fruits\n";
    plan += "Lunch: Quinoa salad with veggies\n";
    plan += "Dinner: Lentil curry with rice\n";
  } else if (data.preferences.toLowerCase().includes('keto')) {
    plan += "Breakfast: Eggs with avocado\n";
    plan += "Lunch: Chicken with leafy greens\n";
    plan += "Dinner: Salmon with asparagus\n";
  } else {
    plan += "Breakfast: Whole grain toast with protein\n";
    plan += "Lunch: Balanced plate with protein, carbs, veggies\n";
    plan += "Dinner: Protein with vegetables and healthy carbs\n";
  }
  
  if (data.frequency > 3) {
    plan += "\nSnacks:\n";
    plan += "- Greek yogurt with berries\n";
    plan += "- Handful of nuts\n";
  }
  
  return plan;
}

function generateCyclePredictions(data) {
  const lastPeriod = new Date(data.lastPeriod);
  const cycleLength = parseInt(data.cycleLength) || 28;
  const nextPeriod = new Date(lastPeriod);
  nextPeriod.setDate(lastPeriod.getDate() + cycleLength);
  
  let predictions = `📅 *Cycle Predictions*\n`;
  predictions += `Next period: ${nextPeriod.toDateString()}\n`;
  predictions += `Fertile window: ${calculateFertileWindow(lastPeriod, cycleLength)}\n`;
  return predictions;
}

function calculateFertileWindow(lastPeriod, cycleLength) {
  const ovulationDay = new Date(lastPeriod);
  ovulationDay.setDate(lastPeriod.getDate() + (cycleLength - 14));
  const startWindow = new Date(ovulationDay);
  startWindow.setDate(ovulationDay.getDate() - 5);
  const endWindow = new Date(ovulationDay);
  endWindow.setDate(ovulationDay.getDate() + 1);
  
  return `${startWindow.toDateString()} to ${endWindow.toDateString()}`;
}

async function safeReply(phone, message) {
  try {
    await client.sendMessage(phone, message);
    logger.info(`Message sent to ${phone}: ${message}`);
  } catch (err) {
    logger.error(`Message sending error to ${phone}: ${err.message}`);
  }
}

// Updated conversation flows to use cohere. and db. prefixes
async function handleNewUserGreeting(phone) {
  await safeReply(phone, "👋 Hello! I'm Aliya, your AI health assistant.");
  await safeReply(phone, TERMS_AND_CONDITIONS);
  stateManager.setState(phone, { awaitingConsent: true });
}

async function handleConsentResponse(phone, response) {
  const cleanResponse = response.toLowerCase().trim();
  logger.info(`Consent response from ${phone}: ${cleanResponse}`);

  if (cleanResponse === 'yes') {
    await safeReply(phone, "Thank you! Let's create your profile. What's your full name?");
    stateManager.setState(phone, { 
      awaitingConsent: false, 
      onboarding: { 
        step: 'name', 
        data: {} 
      } 
    });
  } else if (cleanResponse === 'no') {
    await safeReply(phone, "I understand. Feel free to message me if you change your mind. Have a healthy day! 👋");
    stateManager.cleanup(phone);
  } else {
    await safeReply(phone, "Please respond with 'yes' or 'no'.");
  }
}

async function completeOnboarding(phone, profileData) {
  try {
    await db.saveUserProfile(phone, profileData);
    const bmi = calculateBMI(profileData.height, profileData.weight);
    await safeReply(phone, `🎉 Profile complete! Your BMI: ${bmi}`);

    await safeReply(phone,
      `Would you like to do your health assessment now? This will help me give better recommendations.\n\n` +
      `1. Yes, do it now\n` +
      `2. Remind me later\n` +
      `3. No, show me services`
    );

    stateManager.setState(phone, {
      onboardingComplete: true,
      awaitingAssessmentChoice: true
    });
  } catch (err) {
    logger.error(`Profile completion error for ${phone}: ${err.message}`);
    await safeReply(phone, "❌ Error saving your profile. Please try /start again.");
  }
}

async function handleAssessmentChoice(phone, choice) {
  const cleanChoice = choice.toLowerCase().trim();
  logger.info(`Assessment choice from ${phone}: ${cleanChoice}`);

  switch(cleanChoice) {
    case '1':
    case 'yes':
    case 'now':
      await initiateHealthAssessment(phone);
      break;

    case '2':
    case 'later':
    case 'remind me later':
      await safeReply(phone, "I'll remind you in 24 hours. " + AVAILABLE_SERVICES);
      scheduleReminder(phone, 24 * 60 * 60 * 1000);
      break;

    case '3':
    case 'no':
      await safeReply(phone, AVAILABLE_SERVICES);
      break;

    default:
      await safeReply(phone, "Please choose:\n1. Yes\n2. Remind me later\n3. No");
  }
}

async function initiateHealthAssessment(phone) {
  await safeReply(phone, "Great! Let's begin your health assessment...");
  stateManager.setState(phone, {
    awaitingAssessmentChoice: false,
    assessment: { 
      step: 'sleep',
      data: {} 
    }
  });
  await askAssessmentQuestion(phone);
}

async function askAssessmentQuestion(phone) {
  const state = stateManager.getState(phone);
  const assessment = state.assessment;
  
  switch(assessment.step) {
    case 'sleep':
      await safeReply(phone, "How many hours do you sleep per night on average? (4-12)");
      break;
    case 'water':
      await safeReply(phone, "How many glasses of water do you drink daily? (1-20)");
      break;
    case 'exercise':
      await safeReply(phone, "How many days per week do you exercise? (0-7)");
      break;
    case 'stress':
      await safeReply(phone, "Rate your stress level (1-10, where 1 is lowest):");
      break;
    case 'diet':
      await safeReply(phone, "How would you rate your diet quality? (1-10, where 10 is healthiest):");
      break;
    case 'smoking':
      await safeReply(phone, "Do you smoke? (yes/no)");
      break;
    case 'alcohol':
      await safeReply(phone, "How many alcoholic drinks per week? (0-50)");
      break;
    case 'complete':
      await completeHealthAssessment(phone);
      break;
  }
}

async function handleAssessmentResponse(phone, response) {
  const state = stateManager.getState(phone);
  const assessment = state.assessment || {};
  const step = assessment.step || 'start';
  const data = assessment.data || {};

  try {
    switch (step) {
      case 'sleep':
        // Validate sleep hours (4-12)
        const sleepHours = parseInt(response);
        if (isNaN(sleepHours)) {
          await safeReply(phone, 'Please enter a number between 4-12');
          return;
        }
        data.sleepHours = sleepHours;
        stateManager.setState(phone, {
          assessment: {
            step: 'water',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      case 'water':
        // Validate water intake (1-20)
        const waterIntake = parseInt(response);
        if (isNaN(waterIntake)) {
          await safeReply(phone, 'Please enter a number between 1-20');
          return;
        }
        data.waterIntake = waterIntake;
        stateManager.setState(phone, {
          assessment: {
            step: 'exercise',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      case 'exercise':
        // Validate exercise days (0-7)
        const exerciseDays = parseInt(response);
        if (isNaN(exerciseDays)) {
          await safeReply(phone, 'Please enter a number between 0-7');
          return;
        }
        data.exerciseDays = exerciseDays;
        stateManager.setState(phone, {
          assessment: {
            step: 'stress',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      case 'stress':
        // Validate stress level (1-10)
        const stressLevel = parseInt(response);
        if (isNaN(stressLevel)) {
          await safeReply(phone, 'Please enter a number between 1-10');
          return;
        }
        data.stressLevel = stressLevel;
        stateManager.setState(phone, {
          assessment: {
            step: 'diet',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      case 'diet':
        // Validate diet quality (1-10)
        const dietQuality = parseInt(response);
        if (isNaN(dietQuality)) {
          await safeReply(phone, 'Please enter a number between 1-10');
          return;
        }
        data.dietQuality = dietQuality;
        stateManager.setState(phone, {
          assessment: {
            step: 'smoking',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      case 'smoking':
        // Validate smoking response
        const smokes = response.toLowerCase();
        if (!['yes', 'no'].includes(smokes)) {
          await safeReply(phone, 'Please answer with "yes" or "no"');
          return;
        }
        data.smokes = smokes;
        stateManager.setState(phone, {
          assessment: {
            step: 'alcohol',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      case 'alcohol':
        // Validate alcohol intake (0-50)
        const alcoholDrinks = parseInt(response);
        if (isNaN(alcoholDrinks)) {
          await safeReply(phone, 'Please enter a number between 0-50');
          return;
        }
        data.alcoholDrinks = alcoholDrinks;
        stateManager.setState(phone, {
          assessment: {
            step: 'complete',
            data: data
          }
        });
        await askAssessmentQuestion(phone);
        break;

      default:
        await safeReply(phone, 'Assessment completed. Type /help for options.');
        stateManager.cleanup(phone);
    }
  } catch (err) {
    logger.error(`Assessment error for ${phone}:`, err);
    await safeReply(phone, 'Sorry, I encountered an error. Please try again.');
  }

}
async function completeHealthAssessment(phone) {
  const state = stateManager.getState(phone);
  const assessment = state.assessment;
  
  try {
    const score = calculateHealthScore(assessment.data);
    await safeReply(phone, `Your health score: ${score}/100\n${getHealthRecommendations(score)}`);
    
    await db.saveHealthAssessment(phone, {
      score: score,
      lifestyle_data: assessment.data,
      recommendations: getHealthRecommendations(score)
    });
    
    stateManager.setState(phone, { 
      assessment: null,
      lastAssessment: new Date().toISOString() 
    });
    
    await safeReply(phone, AVAILABLE_SERVICES);
  } catch (err) {
    logger.error(`Assessment completion error: ${err.message}`);
    await safeReply(phone, "⚠️ Error saving your assessment. Please try again later.");
  }
}

function scheduleReminder(phone, delayMs) {
  stateManager.setReminder(phone, setTimeout(async () => {
    await safeReply(phone, "⏰ Reminder: Ready to complete your health assessment? Type 'yes' to begin.");
    stateManager.setState(phone, { reminderSent: true });
    logger.info(`Reminder sent to ${phone}`);
  }, delayMs));
}

// Updated message handler to use cohere. and db. prefixes
async function handleMessage(msg) {
  const phone = msg.from;
  const body = msg.body?.trim();
  logger.info(`Message received from ${phone}: ${body}`);

  if (!body) {
    await safeReply(phone, "Please send a valid message.");
    return;
  }

  const state = stateManager.getState(phone);
  const user = await db.getUserProfile(phone);

  try {
    // Handle new users
    if (!user && !state?.onboarding && !state?.awaitingConsent && !body.startsWith('/')) {
      return await handleNewUserGreeting(phone);
    }

    // Handle assessment responses
    if (state?.assessment) {
      return handleAssessmentResponse(phone, body);
    }

    // Handle consent
    if (state?.awaitingConsent) {
      return handleConsentResponse(phone, body);
    }

    // Handle assessment choice
    if (state?.awaitingAssessmentChoice) {
      return handleAssessmentChoice(phone, body);
    }

    // Handle onboarding
    if (state?.onboarding) {
      const { step } = state.onboarding;
      const data = state.onboarding.data || {};

      switch(step) {
        case 'name':
          data.name = body;
          await safeReply(phone, "How old are you?");
          stateManager.setState(phone, { onboarding: { step: 'age', data } });
          break;
        case 'age':
          if (!/^\d+$/.test(body) || parseInt(body) < 0 || parseInt(body) > 150) {
            await safeReply(phone, "Please enter a valid age (0-150).");
            return;
          }
          data.age = parseInt(body);
          await safeReply(phone, "What's your sex? (male/female/other)");
          stateManager.setState(phone, { onboarding: { step: 'sex', data } });
          break;
        case 'sex':
          if (!['male', 'female', 'other'].includes(body.toLowerCase())) {
            await safeReply(phone, "Please enter 'male', 'female', or 'other'.");
            return;
          }
          data.sex = body.toLowerCase();
          await safeReply(phone, "What's your height in cm?");
          stateManager.setState(phone, { onboarding: { step: 'height', data } });
          break;
        case 'height':
          if (!/^\d+(\.\d+)?$/.test(body) || parseFloat(body) < 50 || parseFloat(body) > 300) {
            await safeReply(phone, "Please enter a valid height in cm (50-300).");
            return;
          }
          data.height = parseFloat(body);
          await safeReply(phone, "What's your weight in kg?");
          stateManager.setState(phone, { onboarding: { step: 'weight', data } });
          break;
        case 'weight':
          if (!/^\d+(\.\d+)?$/.test(body) || parseFloat(body) < 20 || parseFloat(body) > 300) {
            await safeReply(phone, "Please enter a valid weight in kg (20-300).");
            return;
          }
          data.weight = parseFloat(body);
          await safeReply(phone, "Any medical history or conditions? (Enter 'none' if none)");
          stateManager.setState(phone, { onboarding: { step: 'medical_history', data } });
          break;
        case 'medical_history':
          data.medical_history = body;
          await completeOnboarding(phone, data);
          stateManager.setState(phone, { onboarding: null });
          break;
      }
      return;
    }

    // Handle commands
    if (body.startsWith('/')) {
      const [command, ...args] = body.split(' ');
      
      switch(command.toLowerCase()) {
        case '/start':
          if (user) {
            await safeReply(phone, `Welcome back ${user.name}! ${AVAILABLE_SERVICES}`);
          } else {
            await handleNewUserGreeting(phone);
          }
          break;

        case '/diagnose':
          if (!args.length) {
            await safeReply(phone, "Please describe symptoms after /diagnose");
            return;
          }
          const symptoms = args.join(' ');
          try {
            const diagnosis = await cohere.generateDiagnosisResponse(phone, symptoms);
            await safeReply(phone, diagnosis);
            await db.saveDiagnosis(phone, symptoms, diagnosis);
          } catch (err) {
            logger.error(`Diagnosis error: ${err.message}`);
            await safeReply(phone, "I couldn't analyze symptoms. Please consult a doctor if concerned.");
          }
          break;

        case '/fit':
          await safeReply(phone, "Starting your fitness program! What are your fitness goals?\n1. Weight loss\n2. Muscle gain\n3. Endurance\n4. General fitness");
          stateManager.setState(phone, { 
            fitness: { 
              step: 'goals',
              data: {} 
            } 
          });
          break;

        case '/meals':
          await safeReply(phone, "Creating meal plans! What are your dietary preferences?\n1. Vegetarian\n2. Vegan\n3. Low-carb\n4. Keto\n5. Balanced");
          stateManager.setState(phone, { 
            meals: { 
              step: 'preferences',
              data: {} 
            } 
          });
          break;

        case '/cycle':
          if (user?.sex !== 'female') {
            await safeReply(phone, "Cycle tracking is available only for female users.");
            return;
          }
          await safeReply(phone, "When was the first day of your last menstrual period? (YYYY-MM-DD)");
          stateManager.setState(phone, { 
            cycle: { 
              step: 'last_period',
              data: {} 
            } 
          });
          break;

        case '/data':
          const analysis = await cohere.generateHealthAnalysis(phone);
          if (analysis) {
            await safeReply(phone, analysis);
          } else {
            await safeReply(phone, "No health data found. Complete an assessment first!");
          }
          break;

        case '/periodtips':
          const tips = await cohere.generatePeriodTips(phone);
          if (tips) {
            await safeReply(phone, tips);
          } else {
            await safeReply(phone, "This feature is for female users. Need other health tips?");
          }
          break;

        case '/help':
          await safeReply(phone, AVAILABLE_SERVICES);
          break;

        default:
          await safeReply(phone, `Unknown command. ${AVAILABLE_SERVICES}`);
      }
      return;
    }

    // Handle fitness program
    if (state?.fitness) {
      const { step, data } = state.fitness;
      
      switch(step) {
        case 'goals':
          data.goals = body;
          await safeReply(phone, "How many days can you workout weekly? (1-7)");
          stateManager.setState(phone, { fitness: { step: 'frequency', data } });
          break;
          
        case 'frequency':
          if (!/^[1-7]$/.test(body)) {
            await safeReply(phone, "Please enter a number between 1-7");
            return;
          }
          data.frequency = body;
          await safeReply(phone, "What equipment do you have?\n1. None\n2. Dumbbells\n3. Resistance bands\n4. Full gym");
          stateManager.setState(phone, { fitness: { step: 'equipment', data } });
          break;
          
        case 'equipment':
          data.equipment = body;
          try {
            const plan = generateFitnessPlan(data);
            await safeReply(phone, `Your fitness plan:\n${plan}`);
            await db.saveFitnessPlan(phone, data);
            stateManager.setState(phone, { fitness: null });
          } catch (err) {
            logger.error(`Fitness plan error: ${err.message}`);
            await safeReply(phone, `Here's your plan:\n${generateFitnessPlan(data)}\n\nCouldn't save to profile.`);
            stateManager.setState(phone, { fitness: null });
          }
          break;
      }
      return;
    }

    // Handle meal plans
    if (state?.meals) {
      const { step, data } = state.meals;
      
      switch(step) {
        case 'preferences':
          data.preferences = body;
          await safeReply(phone, "Any food allergies? (comma separated or 'none')");
          stateManager.setState(phone, { meals: { step: 'allergies', data } });
          break;
          
        case 'allergies':
          data.allergies = body;
          await safeReply(phone, "How many meals per day? (3-6)");
          stateManager.setState(phone, { meals: { step: 'frequency', data } });
          break;
          
        case 'frequency':
          if (!/^[3-6]$/.test(body)) {
            await safeReply(phone, "Please enter a number between 3-6");
            return;
          }
          data.frequency = body;
          try {
            const mealPlan = generateMealPlan(data);
            await safeReply(phone, `Your meal plan:\n${mealPlan}`);
            await db.saveMealPlan(phone, data);
            stateManager.setState(phone, { meals: null });
          } catch (err) {
            logger.error(`Meal plan error: ${err.message}`);
            await safeReply(phone, `Here's your plan:\n${generateMealPlan(data)}\n\nCouldn't save to profile.`);
            stateManager.setState(phone, { meals: null });
          }
          break;
      }
      return;
    }

    // Handle cycle tracking
    if (state?.cycle) {
      const { step, data } = state.cycle;
      
      switch(step) {
        case 'last_period':
          if (!/^\d{4}-\d{2}-\d{2}$/.test(body)) {
            await safeReply(phone, "Please use YYYY-MM-DD format");
            return;
          }
          data.lastPeriod = body;
          await safeReply(phone, "Typical cycle length in days? (21-35)");
          stateManager.setState(phone, { cycle: { step: 'length', data } });
          break;
          
        case 'length':
          if (!/^(2[1-9]|3[0-5])$/.test(body)) {
            await safeReply(phone, "Please enter a number between 21-35");
            return;
          }
          data.cycleLength = body;
          const predictions = generateCyclePredictions(data);
          await safeReply(phone, `Your cycle predictions:\n${predictions}`);
          await db.saveCycleData(phone, data);
          stateManager.setState(phone, { cycle: null });
          break;
      }
      return;
    }

    // Handle general health questions
    if (body.length > 10 && /health|symptom|pain|doctor|medical/i.test(body)) {
      const answer = await cohere.answerGeneralHealthQuestion(phone, body);
      await safeReply(phone, answer);
      return;
    }

    // Default response
    await safeReply(phone, `How can I help with your health today? ${AVAILABLE_SERVICES}`);

  } catch (err) {
    logger.error(`Message handling error: ${err.message}`);
    await safeReply(phone, "Sorry, I encountered an error. Please try again.");
  }
}

// WhatsApp client events
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  logger.info('QR code generated');
});

client.on('ready', async () => {
  logger.info('WhatsApp client ready');
  try {
    await db.initializeDatabase();
    logger.info('All services initialized successfully');
  } catch (err) {
    logger.error(`Initialization error: ${err.message}`);
    process.exit(1);
  }
});

client.on('message', handleMessage);

// Start server and client
app.listen(process.env.PORT || 3000, () => {
  logger.info('Server started');
  client.initialize();
});

// Error handling
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled promise rejection: ${err.message}`);
});

// Clean up stale sessions hourly
setInterval(() => {
  const now = Date.now();
  stateManager.states.forEach((state, phone) => {
    if (state.lastActivity && (now - state.lastActivity > 24 * 60 * 60 * 1000)) {
      stateManager.cleanup(phone);
    }
  });
}, 60 * 60 * 1000);