const { Resend } = require('resend');

class EmailService {
    constructor() {
        this.resend = null;
        if (process.env.RESEND_API_KEY) {
            this.resend = new Resend(process.env.RESEND_API_KEY);
        } else {
            console.warn('RESEND_API_KEY not found in .env. Email outreach will be simulated.');
        }
    }

    /**
     * Sends an email via Resend
     * @param {string} to - Recipient email
     * @param {string} subject - Email subject
     * @param {string} content - HTML content
     */
    async sendEmail(to, subject, content) {
        if (!this.resend) {
            console.log(`[SIMULATED EMAIL SERVICE] To: ${to} Subject: ${subject}`);
            await new Promise(r => setTimeout(r, 1000));
            return { success: true, message: 'Simulated email sent (no API key)' };
        }

        try {
            const { data, error } = await this.resend.emails.send({
                from: 'Synreach <onboarding@resend.dev>', // Default for unverified domains
                to: [to],
                subject: subject,
                html: content,
            });

            if (error) {
                console.error('Resend Error:', error);
                throw new Error(error.message);
            }

            return { success: true, data };
        } catch (error) {
            console.error('EmailService sendEmail Error:', error);
            throw error;
        }
    }
}

module.exports = new EmailService();
