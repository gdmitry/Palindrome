'use strict';

var palindrome = require('../../src/Palindrome.js');

describe('Palindrome', function () {

	describe('split test string on substrings', function () {

		it('get correct number of substrings', function () {
			var input = "abcd";
			var output = palindrome.splitOnSubstrings(input);
			expect(output).toEqual(["ab", "abc", "abcd", "bc", "bcd", "cd"]);
		});

		it('return empty array when input is empty string', function () {
			var input = "";
			var output = palindrome.splitOnSubstrings(input);
			expect(output.length).toEqual(0);
		});

		it('return empty array when input has length 1', function () {
			var input = "a";
			var output = palindrome.splitOnSubstrings(input);
			expect(output.length).toEqual(0);
		});
	});


	describe('check if string is palindrome', function () {

		it('return true if input string is a palindrome with odd length', function () {
			var input = "ada";
			expect(palindrome.checkIfPalyndrom(input)).toBe(true);
		});

		it('return true if input string is a palindrome with even length', function () {
			var input = "adda";
			expect(palindrome.checkIfPalyndrom(input)).toBe(true);
			input = "aa";
			expect(palindrome.checkIfPalyndrom(input)).toBe(true);
		});

		it('return false if input string is not a palindrome', function () {
			var input = "adac";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);

			input = "ad";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);
		});

		it('return false if input string is a palindrome in lowercase and ignoreCase=false', function () {
			var input = "Sum summus mus";
			expect(palindrome.checkIfPalyndrom(input, false)).toBe(false);
		});

		it('return true if input string is a palindrome in lowercase and ignoreCase=true', function () {
			var input = "Sum summus mus";
			expect(palindrome.checkIfPalyndrom(input, true)).toBe(true);
		});

		it('return false if input string has length 1', function () {
			var input = "a";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);
		});

		it('return false if input string is empty', function () {
			var input = "";
			expect(palindrome.checkIfPalyndrom(input)).toBe(false);
		});
	});

	describe('find all palindromes in string', function () {

		it('return all palindromes within an input string', function () {
			var input = "yabxyzyxba1";
			var output = palindrome.testPalyndrom(input);
			expect(output).toEqual(["abxyzyxba", "bxyzyxb", "xyzyx", "yzy"]);
		});

		it('sort all palindromes by length within an input string in descending order', function () {
			var input = ["bab", "bb", "abba"];
			var output = palindrome.sortPalindromes(input);
			expect(output).toEqual(["abba", "bab", "bb"]);
		});
		
		it('return only unique palindromes', function () {
			var input = ["bab", "bb", "abba","bb"];
			var output = palindrome.getUniquePalindromes(input);
			expect(output).toEqual(["bab", "bb", "abba"]);
		});
	});
});