define(['../../node_modules/jquery/dist/jquery.js'], function ($) {
	'use strict';

	var Display = {
		displayResults: displayResults		
	};

	return Display;

	function displayResults(results) {
		var list = $('.result-list');

		list.empty();
		results.forEach(function (item) {
			list.append('<li>' + item + '</li>');
		});		
		
		if(!results.length) {
			list.append('No palindromes found.');
		}			
	}

});