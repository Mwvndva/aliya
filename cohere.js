const { CohereClient } = require('cohere-ai');
const logger = require('winston');
const { 
  getUserProfile, 
  getLatestHealthAssessment,
  saveDiagnosis,
  saveHealthAssessment
} = require('./db');

// Personality Configuration
const ALIYA_PERSONALITY = `
You are Aliya, a compassionate AI health assistant. Follow these rules:

1. Response Style:
- Use the patient's name when known
- Include 1-2 relevant emojis maximum (❤️🩺)
- For serious symptoms, always recommend professional care
- Break complex information into bullet points

2. Medical Guidelines:
- List most likely conditions first
- Provide clear self-care instructions
- Highlight danger signs in ALL CAPS
- Never diagnose - suggest possibilities
`;

// Initialize Cohere client
const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY,
  temperature: 0.5,
  maxTokens: 300
});

// Core Response Generator
async function generateAliyaResponse(userName, message, context = {}) {
  const prompt = `${ALIYA_PERSONALITY}
  
Patient: ${userName || "User"}
Context: ${context.type || 'general inquiry'}
Message: ${message}

Generate a helpful, structured response:`;

  try {
    const response = await cohere.generate({
      prompt: prompt,
      max_tokens: 300,
      temperature: 0.6
    });
    
    return formatResponse(response.generations[0].text, userName);
  } catch (err) {
    logger.error('AI Response Error:', err);
    return getFallbackMessage(context.type);
  }
}

// Helper Functions
function buildHealthContext(user, assessment) {
  if (!assessment) return 'No health history available';
  
  return `Health Background:
- Age: ${user?.age || 'Unspecified'}
- Sex: ${user?.sex || 'Unspecified'}
- Sleep: ${assessment.lifestyle_data?.sleepHours || '?'} hrs/night
- Stress: ${assessment.lifestyle_data?.stressLevel || '?'}/10
- Diet: ${assessment.lifestyle_data?.dietQuality || '?'}/10`;
}

function formatResponse(text, userName) {
  let formatted = text;
  if (userName) {
    formatted = formatted.replace(/\[name\]/gi, userName)
                        .replace(/\buser\b/gi, userName);
  }
  return formatted.replace(/\n+/g, '\n').trim();
}

function getFallbackMessage(type) {
  const fallbacks = {
    diagnosis: "I can't analyze symptoms currently. Please monitor for:\n- Worsening condition\n- Fever\n- Unusual pain",
    assessment: "Health analysis unavailable. Try again later.",
    general: "I'm having trouble responding. Please rephrase your question."
  };
  return fallbacks[type] || fallbacks.general;
}

// Health Analysis Functions
async function generateDiagnosisResponse(phone, symptoms) {
  try {
    const [user, assessment] = await Promise.all([
      getUserProfile(phone),
      getLatestHealthAssessment(phone)
    ]);

    const context = buildHealthContext(user, assessment);
    const diagnosis = await generateAliyaResponse(
      user?.name,
      `Analyze these symptoms:
${symptoms}

${context}

Provide:
1. Top 3 possible causes (with % likelihood)
2. Home care recommendations
3. RED FLAGS requiring medical attention`,
      { type: 'diagnosis' }
    );

    await saveDiagnosis(phone, symptoms, diagnosis);
    return diagnosis;

  } catch (err) {
    logger.error('Diagnosis Failed:', err);
    return `I'm unable to analyze symptoms right now. For ${symptoms}, watch for:\n\n` +
           "- Fever above 38°C\n- Difficulty breathing\n- Severe pain\n\n" +
           "When in doubt, consult a doctor.";
  }
}

async function generateHealthAnalysis(phone) {
  try {
    const [user, assessment] = await Promise.all([
      getUserProfile(phone),
      getLatestHealthAssessment(phone)
    ]);
    
    if (!assessment) return "Complete a health assessment first (/assessment)";
    
    return generateAliyaResponse(
      user?.name,
      `Analyze this health data:
${JSON.stringify(assessment.lifestyle_data, null, 2)}

Provide:
1. Health strengths
2. Improvement areas
3. Actionable steps`,
      { type: 'assessment' }
    );
  } catch (err) {
    logger.error('Analysis Failed:', err);
    return "Couldn't generate health analysis. Try again later.";
  }
}

async function generatePeriodTips(phone) {
  try {
    const user = await getUserProfile(phone);
    if (!user || user.sex !== 'female') {
      return "Cycle tracking available for female users.";
    }
    
    return generateAliyaResponse(
      user.name,
      "Provide menstrual health guidance covering:\n1. Pain relief\n2. Nutrition\n3. Comfort\n4. Warning signs",
      { type: 'menstrual' }
    );
  } catch (err) {
    logger.error('Period Tips Error:', err);
    return "General tips: Stay hydrated, use heat therapy, monitor symptoms.";
  }
}

async function answerGeneralHealthQuestion(phone, question) {
  try {
    const user = await getUserProfile(phone);
    return generateAliyaResponse(
      user?.name,
      `Answer this health question:
${question}

Include:
1. Clear explanation
2. Practical advice
3. When to seek help`,
      { type: 'general' }
    );
  } catch (err) {
    logger.error('Q&A Error:', err);
    return "I can't answer that now. For urgent concerns, contact a doctor.";
  }
}

// Exports
module.exports = {
  generateDiagnosisResponse,
  generateHealthAnalysis,
  generatePeriodTips,
  answerGeneralHealthQuestion
};