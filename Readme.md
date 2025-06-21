## To run locally:

1.  Copy and fill your `.env`:
    ```bash
    cp .env.example .env
    ```
2.  Start the bot:
    ```bash
    npm install
    npm start
    ```
3.  In another terminal, start ngrok:
    ```bash
    ngrok http 8080
    ```
4.  In Plivo’s Voice App settings:
    - Answer URL → `https://<your-ngrok-id>.ngrok.io/answer.xml`
    - Media Streams Socket → `wss://<your-ngrok-id>.ngrok.io`

Now Plivo will fetch /answer.xml, open the WebSocket at your tunnel, and stream audio to your local bot.
