//require.config({
//    paths: {      
//        'Palindrome': '../src/Palindrome'       
//    }
//});
//
//require([
//        './specs/PalindromeSpec'       
//],
//    function () {
//        (typeof console !== 'undefined' && typeof console.log === "function") ? console.log("Jasmine started..") : "";
//        jasmine.getEnv().execute();
//    });

'use strict';

describe('Module', function () {
	require('./specs/PalindromeSpec.js');	
});