const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.type('text/plain').send('ok');
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`React app listening on http://0.0.0.0:${port}`);
});
