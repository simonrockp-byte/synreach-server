const axios = require('axios');

/**
 * WhatsApp Service (Meta Cloud API Version)
 * This replaces the legacy whatsapp-web.js implementation which required Chrome.
 */
class WhatsAppService {
  constructor() {
    this.accessToken = process.env.WHATSAPP_TOKEN;
    this.phoneId = process.env.WHATSAPP_PHONE_ID;
    this.version = 'v23.0'; // Latest Meta API version
    this.isReady = !!(this.accessToken && this.phoneId);

    if (this.isReady) {
      console.log('WhatsApp Cloud API Service initialized.');
    } else {
      console.warn('WhatsApp Cloud API missing credentials. Service suspended.');
    }
  }

  /**
   * Sends a message using Meta Cloud API
   * @param {string} to - Recipient phone number in international format
   * @param {string} text - Message body
   */
  async safeSend(to, text) {
    if (!this.isReady) throw new Error('WhatsApp service not initialized');
    
    // Clean phone number (remove +, spaces, dashes)
    const cleanTo = to.replace(/\D/g, '');

    console.log(`[WHATSAPP] Sending message to ${cleanTo}...`);

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${this.version}/${this.phoneId}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: cleanTo,
          type: "text",
          text: { body: text }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('[WHATSAPP] Message delivered successfully.');
      return response.data;
    } catch (error) {
      console.error('[WHATSAPP] Send failed:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new WhatsAppService();
