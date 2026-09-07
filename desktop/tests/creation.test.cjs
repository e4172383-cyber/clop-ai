const test = require('node:test');
const assert = require('node:assert/strict');
const {strongest} = require('../src/renderer/creation.js');
test('recommendation excludes locked and promotional models outside the plan', () => {
 const models = [{key:'gpt-astra',available:true,plans:['go']},{key:'gpt-sol',available:true,plans:['free','go']},{key:'gpt-terra',available:true,plans:['free']}];
 assert.equal(strongest(models,'free').key,'gpt-sol');
 assert.equal(strongest(models,'go').key,'gpt-astra');
 models[0].available=false;
 assert.equal(strongest(models,'go').key,'gpt-sol');
 assert.equal(strongest([], 'free'),null);
 assert.equal(strongest([{key:'gpt-astra'}],'go'),null);
});
