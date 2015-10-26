'use strict';

var palindrome = require('./Palindrome.js'),
	$ = require('../node_modules/jquery/dist/jquery.js');


$(".sendButton").click(function () {
	var testString = $(".input-field").val();
	palindrome.testPalyndrom(testString);
	return false;
});

$(".resetButton").click(function () {
	$(".input-field").val('ggfg');
	return false;
});