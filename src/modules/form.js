define(['../../node_modules/jquery/dist/jquery.js', './palindrome.js', './display.js'], function ($, palindrome, display) {
	'use strict';	

	$(".form").submit(function (event) {
		var results, inputs = {};
		var collection = $(event.target).find("input");

		$.each(collection, function (index, input) {
			inputs[input.name] = (input.type === 'radio' ||
				input.type === 'checkbox') ? input.checked : input.value;
		});

		results = palindrome.testPalyndrom(inputs['test-string'], inputs['case']);
		display.displayResults(results);
		$(".fix").addClass('result');
		event.preventDefault();
	});
	
	$(".form").on('reset', function () {
		$(".fix").removeClass('result');
	});

});