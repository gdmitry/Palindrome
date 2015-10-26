'format amd';

define(['jquery', 'Palindrome','semantic-ui'], function ($, palindrome, semantic) {
	'use strict';

	$(".sendButton").click(function () {
		var testString = $(".input-field").val();
		palindrome.testPalyndrom(testString);
		return false;
	});

	$(".sendButton").click(function () {
		var testString = $(".input-field").val();
		palindrome.testPalyndrom(testString);
		return false;
	});
	
});

