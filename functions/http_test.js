const functions = require('firebase-functions');
const admin = require('firebase-admin');
try{ admin.initializeApp(); }catch(e){}

exports.httpEchoTest = functions.https.onRequest((req, res) => {
  res.status(200).send('OK');
});
