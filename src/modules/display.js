define(['../../node_modules/jquery/dist/jquery.js'], function ($) {
	'use strict';

	var list = $('.result-list');

	function displayResults(results) {
		var innerHTML = results.map(function (item) {
			return '<li>' + item + '</li>';
		}).join('');
		
		if (!results.length) {
			list.html('No palindromes found.');
		}else {
			list.html(innerHTML);
		}
	}

	return {
		displayResults: displayResults
	};
});