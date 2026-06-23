module.exports = async function handler(req, res) {
	try {
		if (req.method !== 'POST') {
			res.setHeader('Allow', 'POST');
			return res.status(405).end('Method Not Allowed');
		}

		// Parse body if not already parsed by framework
		let body = req.body;
		if (!body) {
			body = await new Promise((resolve, reject) => {
				let data = '';
				req.on('data', chunk => (data += chunk));
				req.on('end', () => {
					try {
						resolve(JSON.parse(data));
					} catch (e) {
						resolve(data);
					}
				});
				req.on('error', reject);
			});
		}

		// TODO: validate signature / process webhook payload

		return res.status(200).json({ ok: true, received: true, body });
	} catch (err) {
		console.error('webhook handler error:', err);
		return res.status(500).json({ error: 'Internal Server Error' });
	}
}

