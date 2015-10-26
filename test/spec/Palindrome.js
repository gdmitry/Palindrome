'use strict';

var Palindrome = require('../../src/Palindrome.js');

describe('drawable', function () {
	it('has correct interface', function () {
	
		expect("xcxacxz").toBeDefined();
	});

//	it('is visible by default', function () {
//		var element = new Drawable();
//		expect(element.color).toBe('gray');
//	});
//
//	it('has {0;0} coordinates by default', function () {
//		var element = new Drawable();
//		expect(element.top).toBe(0);
//		expect(element.left).toBe(0);
//	});
//
//	it('can be configured', function () {
//		var config = {
//			left: 774,
//			top: 88,
//			color: 'red'
//		}
//		var element = new Drawable(config);
//		expect(element.left).toEqual(config.left);
//		expect(element.top).toEqual(config.top);
//		expect(element.color).toEqual(config.color);
//	});
});