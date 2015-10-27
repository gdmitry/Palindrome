define(function () {
	'use strict';

	var Palindrome = {
		testPalyndrom: testPalyndrom,
		checkIfPalyndrom: checkIfPalyndrom,
		splitOnSubstrings: splitOnSubstrings,
		sortPalindromes: sortPalindromes,
		getUniquePalindromes: getUniquePalindromes
	};

	return Palindrome;

	function splitOnSubstrings(testString) {
		var i, j, substrings = [];

		for (i = 0; i < testString.length; i++) {
			for (j = i + 1; j < testString.length; j++) {
				substrings.push(testString.substring(i, j + 1));
			}
		}
		return substrings;
	}

	function testPalyndrom(testString, ignoreCase) {
		var substrings = splitOnSubstrings(testString);
		var palindromes = [];

		substrings.forEach(function (str) {
			if (checkIfPalyndrom(str, ignoreCase)) {
				palindromes.push(str);
			}
		});
		
		palindromes = getUniquePalindromes(palindromes);
		sortPalindromes(palindromes);

		return palindromes;
	}

	function getUniquePalindromes(palindromes) {		
		var uniquePalindromes = palindromes.filter(function (item, index) {
			return palindromes.indexOf(item) == index;
		});

		return uniquePalindromes;
	}

	function sortPalindromes(palindromes) {
		palindromes.sort(function (p1, p2) {
			if (p1.length < p2.length) {
				return 1;
			}
			if (p1.length > p2.length) {
				return -1;
			}
			return 0;
		});

		return palindromes;
	}

	function checkIfPalyndrom(str, ignoreCase) {
		var i, index = Math.floor(str.length / 2);

		if (!str.length || str.length == 1) {
			return false;
		}

		if (ignoreCase) {
			str = str.toLowerCase();
		}

		for (i = 0; str[i] === str[str.length - 1 - i]; i++) {
			if (i > index) {
				return true;
			}
		}

		return false;
	}
});