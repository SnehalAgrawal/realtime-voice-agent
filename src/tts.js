const sdk = require("microsoft-cognitiveservices-speech-sdk");

const subscriptionKey = process.env.AZURE_SUBSCRIPTION_KEY;
const serviceRegion = process.env.AZURE_SERVICE_REGION;

const getAzureSpeechSynthesizer = () => {
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    subscriptionKey,
    serviceRegion
  );

  speechConfig.speechSynthesisVoiceName = "en-IN-KavyaNeural";
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;

  const speechSynthesizer = new sdk.SpeechSynthesizer(speechConfig);
  return speechSynthesizer;
};

const streamTts = (speechSynthesizer, text) => {
  return new Promise((resolve, reject) => {
    speechSynthesizer.speakTextAsync(
      text,
      (result) => {
        resolve({
          content: Buffer.from(result.audioData),
          duration: result.audioDuration,
        });
      },
      (error) => {
        console.error(`Error in azure TTS: ${error}`);
        console.error(
          `Error in azure synthesis: ${error?.result?.errorDetails}`
        );
        reject(
          new Error(`Azure Synthesis canceled: ${error?.result?.errorDetails}`)
        );
      }
    );
  });
};

module.exports = {
  streamTts,
  getAzureSpeechSynthesizer,
};
