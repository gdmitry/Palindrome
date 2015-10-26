'format amd';

define(function () {
	'use strict';

	var Palindrome = {
		testPalyndrom: testPalyndrom,
		checkIfPalyndrom: checkIfPalyndrom

	};

	return Palindrome;

	function testPalyndrom(testString) {
		var i, j;
		for (i = 0; i < testString.length; i++) {
			for (j = i + 2; j < testString.length; j++) {
				checkIfPalyndrom(testString.substring(i, j + 1));
			}
		}
	};

	function checkIfPalyndrom(str) {
		//		var i = 0;
		//
		//		while ((str[i] === str[str.length - 1 - i])) {
		//			if (i === j) {
		//				console.log("+++", str);
		//				return str;
		//			}
		//			i++;
		//		}
		//
		//		return false;
		
		var i = 0,
			j = str.length - 1;

		while ((str[i] === str[j]) && (i !== j)) {
			i++;
			j--;
		}
		if (i === j) {
			console.log("+++", str);
			return str;
		}
		return false;
	}

});