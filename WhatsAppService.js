const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

class WhatsAppService {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-extensions'
                ]
            }
        });

        this.isReady = false;
        this.initialize();
    }

    initialize() {
        this.client.on('qr', (qr) => {
            console.log('--- SCAN THIS QR CODE WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', () => {
            console.log('WhatsApp Client is READY');
            this.isReady = true;
        });

        this.client.on('authenticated', () => {
            console.log('WhatsApp AUTHENTICATED');
        });

        this.client.on('auth_failure', (msg) => {
            console.error('WhatsApp AUTH FAILURE', msg);
        });

        this.client.initialize();
    }

    /**
     * Sends a message with Anti-Ban safety measures:
     * 1. Randomized Delay (Human rhythm)
     * 2. Simulated Typing status
     * 3. Presence simulation
     */
    async safeSend(number, message) {
        if (!this.isReady) {
            throw new Error('WhatsApp client not ready. Please scan QR code first.');
        }

        // 1. Format number (ensure it ends with @c.us)
        const chatId = number.includes('@') ? number : `${number.replace(/[^0-9]/g, '')}@c.us`;

        try {
            const chat = await this.client.getChatById(chatId);

            // 2. Randomized "Thinking" delay (2-5 seconds)
            const thinkingDelay = Math.floor(Math.random() * 3000) + 2000;
            await new Promise(resolve => setTimeout(resolve, thinkingDelay));

            // 3. Simulate "Typing..."
            await chat.sendStateTyping();

            // 4. Randomized "Typing" delay based on message length (approx 50ms per char)
            const typingSpeed = Math.floor(Math.random() * 20) + 30; // 30-50ms per char
            const typingDuration = Math.min(message.length * typingSpeed, 10000); // Max 10s typing
            await new Promise(resolve => setTimeout(resolve, typingDuration));

            // 5. Send message
            const result = await this.client.sendMessage(chatId, message);
            
            // 6. Stop typing
            await chat.clearState();

            // 7. Post-send randomized cooldown (guards against "burst" detection)
            const cooldown = Math.floor(Math.random() * 5000) + 5000; // 5-10s cooldown
            await new Promise(resolve => setTimeout(resolve, cooldown));

            return result;
        } catch (error) {
            console.error('WhatsApp safeSend Error:', error);
            throw error;
        }
    }
}

module.exports = new WhatsAppService();
