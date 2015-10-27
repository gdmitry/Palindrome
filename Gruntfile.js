module.exports = function (grunt) {
	var DOC_DIR = 'doc';
	var BUILD_DIR = 'build'

	grunt.initConfig({
		jshint: {
			dev: {
				options: {
					jshintrc: '.jshintrc'
				},
				src: [
					'src/modules/*.js'
				]
			}
		},
		watch: {
			sources: {
				files: [
					'src/**/*.js',
					'src/**/*.html',
					'src/**/*.css',
					'test/**/*.js'
				],
				//tasks: ['jshint'],
				options: {
					interrupt: true,
					livereload: 35729
				}
			}
		},
		jsdoc: {
			dist: {
				src: ['src/*.js'],
				dest: DOC_DIR
			}
		},
		clean: {
			doc: [DOC_DIR],
			build: [BUILD_DIR],
			test: ['test/specs.js']
		},
		copy: {
			build: {
				files: [
					{
						expand: true,
						cwd: 'src/',
						src: 'index.html',
						dest: BUILD_DIR + '/',
					},
					{
						expand: true,
						cwd: 'src/styles/',
						src: 'style.css',
						dest: BUILD_DIR + '/'
					},
					{
						expand: true,
						cwd: 'node_modules/semantic-ui-css/',
						src: 'semantic.css',
						dest: BUILD_DIR + '/'
					}					
				]

			}
		},
		jasmine: {
			testAll: {
				options: {
					vendor: [
						'node_modules/systemjs/dist/system.js'
					],
					keepRunner: false,
					outfile: 'test/specs.html',
					specs: ['test/specs.js']
				}
			}			
		},
		systemjs: {
			build: {
				options: {
					source: 'src/modules/index.js',
					output: BUILD_DIR + '/index.js',
					minify: false,
					sourceMaps: true
				}
			},
			buildmin: {
				options: {
					source: 'src/modules/index.js',
					output: BUILD_DIR + '/index.min.js',
					minify: true,
					sourceMaps: true
				}
			},
			test: {
				options: {
					source: 'test/spec.js',
					output: 'test/specs.js',
					minify: false
				}
			}
		}
	});

	grunt.loadNpmTasks('grunt-contrib-jshint');
	grunt.loadNpmTasks('grunt-contrib-watch');
	grunt.loadNpmTasks('grunt-jsdoc');
	grunt.loadNpmTasks('grunt-contrib-clean');
	grunt.loadNpmTasks('grunt-contrib-copy');
	grunt.loadNpmTasks('grunt-contrib-jasmine');
	grunt.loadTasks('custom_modules/grunt-systemjs-builder/tasks');

	grunt.registerTask('live', ['watch']);
	grunt.registerTask('code', ['jshint:dev']);
	grunt.registerTask('doc', ['clean:doc', 'jsdoc']);
	grunt.registerTask('test', ['systemjs:test', 'jasmine', 'clean:test']);
	grunt.registerTask('build', ['clean:build','systemjs:build', 'systemjs:buildmin', 'copy:build']);
	grunt.registerTask('release', ['build', 'test', 'code']);
};