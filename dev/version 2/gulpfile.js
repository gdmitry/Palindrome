'use strict';

var gulp = require('gulp'),
	gutil = require('gulp-util'),
	clean = require('del'),
	gp_rename = require('gulp-rename'),
    gp_uglify = require('gulp-uglify');

gulp.task('build',function () {
	return gulp.src('palindrome.js')
		.pipe(gp_rename('uglify.js'))
		.pipe(gp_uglify())
		.pipe(gulp.dest('dist'));
});