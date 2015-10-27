'use strict';

var palindrome = require('./Palindrome.js'),
	$ = require('../node_modules/jquery/dist/jquery.js');

$(".sendButton").click(function () {
	var testString = $(".test-string").val();
	var ignoreCase = $('.case').prop('checked')

	console.log(ignoreCase);
	displayResults(palindrome.testPalyndrom(testString, ignoreCase));
	return false;
});

$(".resetButton").click(function () {
	$(".test-string").val('');
	$(".fix").removeClass('result');
	return false;
});

function displayResults(results) {
	var list = $('.result-list');

	results.forEach(function (item) {
		list.append('<li>' + item + '</li>');
	});

	if (results.length) {
		$(".fix").addClass('result');
	} else {
		$(".fix").removeClass('result');
	}
}