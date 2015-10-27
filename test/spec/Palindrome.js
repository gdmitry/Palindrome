'use strict';

var palindrome = require('../../src/modules/Palindrome.js');

describe('Palindrome', function () {

	describe('splits string on substrings', function () {

		it('and returns correct number of substrings', function () {
			var input = "abcd";
			var output = palindrome.splitOnSubstrings(input);
			expect(output).toEqual(["ab", "abc", "abcd", "bc", "bcd", "cd"]);
		});

		it('and returns empty array when string is empty', function () {
			var input = "";
			var output = palindrome.splitOnSubstrings(input);
			expect(output.length).toEqual(0);
		});

		it('and returns empty array when string has length 1', function () {
			var input = "a";
			var output = palindrome.splitOnSubstrings(input);
			expect(output.length).toEqual(0);
		});
	});


	describe('checks if string is palindrome', function () {

		it('and returns true if string is a palindrome with odd length', function () {
			var input = "ada";
			expect(palindrome.checkIfPalyndrom(input)).toBe(true);
		});

		it('and returns true if string is a palindrome with even length', function () {
			var input = "adda";
			expect(palindrome.checkIfPalyndrom(input)).toBe(true);
			input = "aa";
			expect(palindrome.checkIfPalyndrom(input)).toBe(true);
		});

		it('and returns false if string is not a palindrome', function () {
			var input = "adc";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);

			input = "ad";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);
		});

		it('and returns false if string is a palindrome in lowercase and ignoreCase=false', function () {
			var input = "Sum summus mus";
			expect(palindrome.checkIfPalyndrom(input, false)).toBe(false);
		});

		it('and returns true if string is a palindrome in lowercase and ignoreCase=true', function () {
			var input = "Sum summus mus";
			expect(palindrome.checkIfPalyndrom(input, true)).toBe(true);
		});

		it('and returns false if string has length 1', function () {
			var input = "a";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);
		});

		it('return false if input string is empty', function () {
			var input = "";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);
		});
	});

	it('finds all palindromes in string', function () {
		var input = "yabxyzyxba1";
		var output = palindrome.testPalyndrom(input);
		expect(output).toEqual(["abxyzyxba", "bxyzyxb", "xyzyx", "yzy"]);
	});

	it('sorts all palindromes by length in descending order', function () {
		var input = ["bab", "bb", "abba"];
		var output = palindrome.sortPalindromes(input);
		expect(output).toEqual(["abba", "bab", "bb"]);
	});

	it('returns only unique palindromes', function () {
		var input = ["bab", "bb", "abba", "bb"];
		var output = palindrome.getUniquePalindromes(input);
		expect(output).toEqual(["bab", "bb", "abba"]);
	});

});