'use strict';

var palindrome = require('./Palindrome.js'),
	jq =  require('../node_modules/jquery/dist/jquery.js');	

jq(".sendButton").click(function () {
	var testString = jq(".test-string").val();
	var ignoreCase = jq('.case').prop('checked');

	console.log(ignoreCase);
	displayResults(palindrome.testPalyndrom(testString, ignoreCase));
	return false;
});

jq(".resetButton").click(function () {
	jq(".test-string").val('');
	jq(".fix").removeClass('result');
	return false;
});

function displayResults(results) {
	var list = jq('.result-list');

	list.empty();
	results.forEach(function (item) {
		list.append('<li>' + item + '</li>');
	});

	if (results.length) {
		jq(".fix").addClass('result');
	} else {
		jq(".fix").removeClass('result');
	}
}