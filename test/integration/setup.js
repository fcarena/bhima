/**
 * @overview setup
 *
 * @description
 * This file runs before all other mocha tests, attaching global variables used in tests.
 *
 * @requires chai
 * @requires q
 * @requires chai-http
 * @requires chai-datetime
 */


// import plugins
const chai = require('chai');
const chaiHttp = require('chai-http');
const chaiDatetime = require('chai-datetime');

// base URL for all tests
const port = process.env.PORT || 8080;
const baseUrl = `http://localhost:${port}`;
global.baseUrl = baseUrl;

// runs before any tests in the repository
before(() => {
  console.log('Setting up test suite...');

  // attach plugins
  chai.use(chaiHttp);
  chai.use(chaiDatetime);

  // set global variables
  global.chai = chai;
  global.expect = chai.expect;
  global.agent = chai.request.agent(baseUrl);
  const { agent } = global;

  // base user defined in test data
  const user = { username : 'superuser', password : 'superuser', project : 1 };

  // trigger login
  return (() => agent.post('/auth/login').send(user))();
});

// runs after all tests are completed
after(() => {
  console.log('Test suite completed.');
});
