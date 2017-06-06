/*global define*/
define([
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/WebGLConstants'
    ], function(
        defaultValue,
        defined,
        WebGLConstants) {
    'use strict';

    function webGLConstantToGlslType(webGLValue) {
        switch(webGLValue) {
            case WebGLConstants.FLOAT:
                return 'float';
            case WebGLConstants.FLOAT_VEC2:
                return 'vec2';
            case WebGLConstants.FLOAT_VEC3:
                return 'vec3';
            case WebGLConstants.FLOAT_VEC4:
                return 'vec4';
            case WebGLConstants.FLOAT_MAT2:
                return 'mat2';
            case WebGLConstants.FLOAT_MAT3:
                return 'mat3';
            case WebGLConstants.FLOAT_MAT4:
                return 'mat4';
            case WebGLConstants.SAMPLER_2D:
                return 'sampler2D';
        }
    }

    function generateLightParameters(gltf) {
        var result = {};

        var lights;
        if (defined(gltf.extensions) && defined(gltf.extensions.KHR_materials_common)) {
            lights = gltf.extensions.KHR_materials_common.lights;
        }

        if (defined(lights)) {
            // Figure out which node references the light
            var nodes = gltf.nodes;
            for (var nodeName in nodes) {
                if (nodes.hasOwnProperty(nodeName)) {
                    var node = nodes[nodeName];
                    if (defined(node.extensions) && defined(node.extensions.KHR_materials_common)) {
                        var nodeLightId = node.extensions.KHR_materials_common.light;
                        if (defined(nodeLightId) && defined(lights[nodeLightId])) {
                            lights[nodeLightId].node = nodeName;
                        }
                        delete node.extensions.KHR_materials_common;
                    }
                }
            }

            // Add light parameters to result
            var lightCount = 0;
            for(var lightName in lights) {
                if (lights.hasOwnProperty(lightName)) {
                    var light = lights[lightName];
                    var lightType = light.type;
                    if ((lightType !== 'ambient') && !defined(light.node)) {
                        delete lights[lightName];
                        continue;
                    }
                    var lightBaseName = 'light' + lightCount.toString();
                    light.baseName = lightBaseName;
                    switch(lightType) {
                        case 'ambient':
                            var ambient = light.ambient;
                            result[lightBaseName + 'Color'] = {
                                type: WebGLConstants.FLOAT_VEC3,
                                value: ambient.color
                            };
                            break;
                        case 'directional':
                            var directional = light.directional;
                            result[lightBaseName + 'Color'] =
                            {
                                type: WebGLConstants.FLOAT_VEC3,
                                value: directional.color
                            };
                            if (defined(light.node)) {
                                result[lightBaseName + 'Transform'] =
                                {
                                    node: light.node,
                                    semantic: 'MODELVIEW',
                                    type: WebGLConstants.FLOAT_MAT4
                                };
                            }
                            break;
                        case 'point':
                            var point = light.point;
                            result[lightBaseName + 'Color'] =
                            {
                                type: WebGLConstants.FLOAT_VEC3,
                                value: point.color
                            };
                            if (defined(light.node)) {
                                result[lightBaseName + 'Transform'] =
                                {
                                    node: light.node,
                                    semantic: 'MODELVIEW',
                                    type: WebGLConstants.FLOAT_MAT4
                                };
                            }
                            result[lightBaseName + 'Attenuation'] =
                            {
                                type: WebGLConstants.FLOAT_VEC3,
                                value: [point.constantAttenuation, point.linearAttenuation, point.quadraticAttenuation]
                            };
                            break;
                        case 'spot':
                            var spot = light.spot;
                            result[lightBaseName + 'Color'] =
                            {
                                type: WebGLConstants.FLOAT_VEC3,
                                value: spot.color
                            };
                            if (defined(light.node)) {
                                result[lightBaseName + 'Transform'] =
                                {
                                    node: light.node,
                                    semantic: 'MODELVIEW',
                                    type: WebGLConstants.FLOAT_MAT4
                                };
                                result[lightBaseName + 'InverseTransform'] = {
                                    node: light.node,
                                    semantic: 'MODELVIEWINVERSE',
                                    type: WebGLConstants.FLOAT_MAT4,
                                    useInFragment: true
                                };
                            }
                            result[lightBaseName + 'Attenuation'] =
                            {
                                type: WebGLConstants.FLOAT_VEC3,
                                value: [spot.constantAttenuation, spot.linearAttenuation, spot.quadraticAttenuation]
                            };

                            result[lightBaseName + 'FallOff'] =
                            {
                                type: WebGLConstants.FLOAT_VEC2,
                                value: [spot.fallOffAngle, spot.fallOffExponent]
                            };
                            break;
                    }
                    ++lightCount;
                }
            }
        }

        return result;
    }

    function getNextId(dictionary, baseName, startingCount) {
        var count = defaultValue(startingCount, 0);
        var nextId;
        do {
            nextId = baseName + (count++).toString();
        } while(defined(dictionary[nextId]));

        return nextId;
    }

    var techniqueCount = 0;
    var vertexShaderCount = 0;
    var fragmentShaderCount = 0;
    var programCount = 0;
    function generateTechnique(gltf, khrMaterialsCommon, lightParameters, options) {
        var techniques = gltf.techniques;
        var shaders = gltf.shaders;
        var programs = gltf.programs;
        var lightingModel = khrMaterialsCommon.technique.toUpperCase();
        var lights;
        if (defined(gltf.extensions) && defined(gltf.extensions.KHR_materials_common)) {
            lights = gltf.extensions.KHR_materials_common.lights;
        }
        var jointCount = defaultValue(khrMaterialsCommon.jointCount, 0);
        var hasSkinning = (jointCount > 0);
        var parameterValues = khrMaterialsCommon.values;

        var vertexShader = 'precision highp float;\n';
        var fragmentShader = 'precision highp float;\n';

        // Generate IDs for our new objects
        var techniqueId = getNextId(techniques, 'technique', techniqueCount);
        var vertexShaderId = getNextId(shaders, 'vertexShader', vertexShaderCount);
        var fragmentShaderId = getNextId(shaders, 'fragmentShader', fragmentShaderCount);
        var programId = getNextId(programs, 'program', programCount);

        var hasNormals = (lightingModel !== 'CONSTANT');

        // Add techniques
        var techniqueParameters = {
            // Add matrices
            modelViewMatrix: {
                semantic: options.useCesiumRTCMatrixInShaders ? 'CESIUM_RTC_MODELVIEW' : 'MODELVIEW',
                type: WebGLConstants.FLOAT_MAT4
            },
            projectionMatrix: {
                semantic: 'PROJECTION',
                type: WebGLConstants.FLOAT_MAT4
            }
        };

        if (hasNormals) {
            techniqueParameters.normalMatrix = {
                semantic: 'MODELVIEWINVERSETRANSPOSE',
                type: WebGLConstants.FLOAT_MAT3
            };
        }

        if (hasSkinning) {
            techniqueParameters.jointMatrix = {
                count: jointCount,
                semantic: 'JOINTMATRIX',
                type: WebGLConstants.FLOAT_MAT4
            };
        }

        // Add material parameters
        var lowerCase;
        var hasTexCoords = false;
        for(var name in parameterValues) {
            //generate shader parameters for KHR_materials_common attributes
            //(including a check, because some boolean flags should not be used as shader parameters)
            if (parameterValues.hasOwnProperty(name) && (name !== 'transparent') && (name !== 'doubleSided')) {
                var valType = getKHRMaterialsCommonValueType(name, parameterValues[name]);
                lowerCase = name.toLowerCase();
                if (!hasTexCoords && (valType === WebGLConstants.SAMPLER_2D)) {
                    hasTexCoords = true;
                }
                techniqueParameters[lowerCase] = {
                    type: valType
                };
            }
        }

        // Copy light parameters into technique parameters
        if (defined(lightParameters)) {
            for (var lightParamName in lightParameters) {
                if (lightParameters.hasOwnProperty(lightParamName)) {
                    techniqueParameters[lightParamName] = lightParameters[lightParamName];
                }
            }
        }

        // Generate uniforms object before attributes are added
        var techniqueUniforms = {};
        for (var paramName in techniqueParameters) {
            if (techniqueParameters.hasOwnProperty(paramName)) {
                var param = techniqueParameters[paramName];
                techniqueUniforms['u_' + paramName] = paramName;
                var arraySize = defined(param.count) ? '['+param.count+']' : '';
                if (((param.type !== WebGLConstants.FLOAT_MAT3) && (param.type !== WebGLConstants.FLOAT_MAT4)) ||
                    param.useInFragment) {
                    fragmentShader += 'uniform ' + webGLConstantToGlslType(param.type) + ' u_' + paramName + arraySize + ';\n';
                    delete param.useInFragment;
                }
                else {
                    vertexShader += 'uniform ' + webGLConstantToGlslType(param.type) + ' u_' + paramName + arraySize + ';\n';
                }
            }
        }

        // Add attributes with semantics
        var vertexShaderMain = '';
        if (hasSkinning) {
            vertexShaderMain += '  mat4 skinMat = a_weight.x * u_jointMatrix[int(a_joint.x)];\n';
            vertexShaderMain += '  skinMat += a_weight.y * u_jointMatrix[int(a_joint.y)];\n';
            vertexShaderMain += '  skinMat += a_weight.z * u_jointMatrix[int(a_joint.z)];\n';
            vertexShaderMain += '  skinMat += a_weight.w * u_jointMatrix[int(a_joint.w)];\n';
        }

        // Add position always
        var techniqueAttributes = {
            a_position: 'position'
        };
        techniqueParameters.position = {
            semantic: 'POSITION',
            type: WebGLConstants.FLOAT_VEC3
        };
        vertexShader += 'attribute vec3 a_position;\n';
        vertexShader += 'varying vec3 v_positionEC;\n';
        if (hasSkinning) {
            vertexShaderMain += '  vec4 pos = u_modelViewMatrix * skinMat * vec4(a_position,1.0);\n';
        }
        else {
            vertexShaderMain += '  vec4 pos = u_modelViewMatrix * vec4(a_position,1.0);\n';
        }
        vertexShaderMain += '  v_positionEC = pos.xyz;\n';
        vertexShaderMain += '  gl_Position = u_projectionMatrix * pos;\n';
        fragmentShader += 'varying vec3 v_positionEC;\n';

        // Add normal if we don't have constant lighting
        if (hasNormals) {
            techniqueAttributes.a_normal = 'normal';
            techniqueParameters.normal = {
                semantic: 'NORMAL',
                type: WebGLConstants.FLOAT_VEC3
            };
            vertexShader += 'attribute vec3 a_normal;\n';
            vertexShader += 'varying vec3 v_normal;\n';
            if (hasSkinning) {
                vertexShaderMain += '  v_normal = u_normalMatrix * mat3(skinMat) * a_normal;\n';
            }
            else {
                vertexShaderMain += '  v_normal = u_normalMatrix * a_normal;\n';
            }

            fragmentShader += 'varying vec3 v_normal;\n';
        }

        // Add texture coordinates if the material uses them
        var v_texcoord;
        if (hasTexCoords) {
            techniqueAttributes.a_texcoord_0 = 'texcoord_0';
            techniqueParameters.texcoord_0 = {
                semantic: 'TEXCOORD_0',
                type: WebGLConstants.FLOAT_VEC2
            };

            v_texcoord = 'v_texcoord_0';
            vertexShader += 'attribute vec2 a_texcoord_0;\n';
            vertexShader += 'varying vec2 ' + v_texcoord + ';\n';
            vertexShaderMain += '  ' + v_texcoord + ' = a_texcoord_0;\n';

            fragmentShader += 'varying vec2 ' + v_texcoord + ';\n';
        }

        if (hasSkinning) {
            techniqueAttributes.a_joint = 'joint';
            techniqueParameters.joint = {
                semantic: 'JOINT',
                type: WebGLConstants.FLOAT_VEC4
            };
            techniqueAttributes.a_weight = 'weight';
            techniqueParameters.weight = {
                semantic: 'WEIGHT',
                type: WebGLConstants.FLOAT_VEC4
            };

            vertexShader += 'attribute vec4 a_joint;\n';
            vertexShader += 'attribute vec4 a_weight;\n';
        }

        vertexShader += 'void main(void) {\n';
        vertexShader += vertexShaderMain;
        vertexShader += '}\n';

        fragmentShader += 'const float M_PI = 3.141592653589793;\n';

        var lambertianDiffuse = '';
        lambertianDiffuse += 'vec3 lambertianDiffuse(vec3 baseColor) {\n';
        lambertianDiffuse += '  return baseColor / M_PI;\n';
        lambertianDiffuse += '}\n\n';

        var fresnelSchlick2 = '';
        fresnelSchlick2 += 'vec3 fresnelSchlick2(vec3 f0, vec3 f90, float VdotH) {\n';
        fresnelSchlick2 += '  return f0 + (f90 - f0) * pow(clamp(1.0 - VdotH, 0.0, 1.0), 5.0);\n';
        fresnelSchlick2 += '}\n\n';

        var fresnelSchlick = '';
        fresnelSchlick += 'vec3 fresnelSchlick(float metalness, float VdotH) {\n';
        fresnelSchlick += '  return metalness + (vec3(1.0) - metalness) * pow(1.0 - VdotH, 5.0);\n';
        fresnelSchlick += '}\n\n';

        var smithVisibilityG1 = '';
        smithVisibilityG1 += 'float smithVisibilityG1(float NdotV, float roughness) {\n';
        smithVisibilityG1 += '  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;\n';
        smithVisibilityG1 += '  return NdotV / (NdotV * (1.0 - k) + k);\n';
        smithVisibilityG1 += '}\n\n';

        var smithVisibilityGGX = '';
        smithVisibilityGGX += 'float smithVisibilityGGX(float roughness, float NdotL, float NdotV) {\n';
        smithVisibilityGGX += '  return smithVisibilityG1(NdotL, roughness) * smithVisibilityG1(NdotV, roughness);\n';
        smithVisibilityGGX += '}\n\n';

        var GGX = '';
        GGX += 'float GGX(float roughness, float NdotH) {\n';
        GGX += '  float roughnessSquared = roughness * roughness;\n';
        GGX += '  float f = (NdotH * roughnessSquared - NdotH) * NdotH + 1.0;\n';
        GGX += '  return roughnessSquared / (M_PI * f * f);\n';
        GGX += '}\n\n';

        fragmentShader += lambertianDiffuse + fresnelSchlick2 + fresnelSchlick + smithVisibilityG1 + smithVisibilityGGX + GGX;

        var fragmentShaderMain = '';
        fragmentShaderMain += 'void main(void) {\n';
        fragmentShaderMain += '  vec3 baseColor = vec3(1.0, 1.0, 1.0);\n';
        fragmentShaderMain += '  float metalness = 1.0;\n';
        fragmentShaderMain += '  float roughness = 1.0;\n'; // clamp to min of 0.04
        fragmentShaderMain += '  vec3 v = -normalize(v_positionEC);\n';
        fragmentShaderMain += '  vec3 ambientLight = vec3(0.0, 0.0, 0.0);\n';

        // Generate lighting code blocks
        var fragmentLightingBlock = '';
        fragmentLightingBlock += '  vec3 lightColor = vec3(1.0, 1.0, 1.0);\n';
        fragmentLightingBlock += '  vec3 n = normalize(v_normal);\n';
        fragmentLightingBlock += '  vec3 l = normalize(czm_sunDirectionEC);\n';
        fragmentLightingBlock += '  vec3 h = normalize(v + l);\n';
        fragmentLightingBlock += '  float NdotL = clamp(dot(n, l), 0.01, 1.0);\n';
        fragmentLightingBlock += '  float NdotV = clamp(dot(n, v), 0.01, 1.0);\n';
        fragmentLightingBlock += '  float NdotH = clamp(dot(n, h), 0.01, 1.0);\n';
        fragmentLightingBlock += '  float LdotH = clamp(dot(l, h), 0.01, 1.0);\n';
        fragmentLightingBlock += '  float VdotH = clamp(dot(v, h), 0.01, 1.0);\n';

        fragmentLightingBlock += '  vec3 f0 = vec3(0.04);\n';
        fragmentLightingBlock += '  vec3 diffuseColor = baseColor * (1.0 - metalness);\n';
        fragmentLightingBlock += '  vec3 specularColor = mix(f0, baseColor, metalness);\n';
        fragmentLightingBlock += '  float reflectance = max(max(specularColor.r, specularColor.g), specularColor.b);\n';
        fragmentLightingBlock += '  vec3 r90 = vec3(clamp(reflectance * 25.0, 0.0, 1.0));\n';
        fragmentLightingBlock += '  vec3 r0 = specularColor.rgb;\n';

        fragmentLightingBlock += '  vec3 F = fresnelSchlick2(r0, r90, VdotH);\n';
        //fragmentLightingBlock += '  vec3 F = fresnelSchlick(metalness, VdotH);\n';
        fragmentLightingBlock += '  float G = smithVisibilityGGX(roughness, NdotL, NdotV);\n';
        fragmentLightingBlock += '  float D = GGX(roughness, NdotH);\n';

        fragmentLightingBlock += '  vec3 diffuseContribution = (1.0 - F) * lambertianDiffuse(baseColor) * NdotL * lightColor;\n';
        fragmentLightingBlock += '  vec3 specularContribution = M_PI * lightColor * F * G * D / (4.0 * NdotL * NdotV);\n';
        fragmentLightingBlock += '  vec3 color = diffuseContribution + specularContribution;\n';

        if (hasNormals) {
            fragmentShaderMain += '  vec3 normal = normalize(v_normal);\n';
            if (khrMaterialsCommon.doubleSided) {
                fragmentShaderMain += '  if (gl_FrontFacing == false)\n';
                fragmentShaderMain += '  {\n';
                fragmentShaderMain += '    normal = -normal;\n';
                fragmentShaderMain += '  }\n';
            }
        }

        var finalColorComputation;
        if (lightingModel !== 'CONSTANT') {
            if (defined(techniqueParameters.diffuse)) {
                if (techniqueParameters.diffuse.type === WebGLConstants.SAMPLER_2D) {
                    fragmentShaderMain += '  vec4 diffuse = texture2D(u_diffuse, ' + v_texcoord + ');\n';
                }
                else {
                    fragmentShaderMain += '  vec4 diffuse = u_diffuse;\n';
                }
            }

            if (defined(techniqueParameters.transparency)) {
                finalColorComputation = '  gl_FragColor = vec4(color * diffuse.a, diffuse.a * u_transparency);\n';
            }
            else {
                finalColorComputation = '  gl_FragColor = vec4(color * diffuse.a, diffuse.a);\n';
            }
        }
        else {
            if (defined(techniqueParameters.transparency)) {
                finalColorComputation = '  gl_FragColor = vec4(color, u_transparency);\n';
            }
            else {
                finalColorComputation = '  gl_FragColor = vec4(color, 1.0);\n';
            }
        }
        //finalColorComputation = '  gl_FragColor = vec4(specularContribution, 1.0);\n';


        // Add in light computations
        fragmentShaderMain += fragmentLightingBlock;
        fragmentShaderMain += finalColorComputation;
        fragmentShaderMain += '}\n';

        fragmentShader += fragmentShaderMain;

        var techniqueStates;
        if (khrMaterialsCommon.transparent) {
            techniqueStates = {
                enable: [
                    WebGLConstants.DEPTH_TEST,
                    WebGLConstants.BLEND
                ],
                depthMask: false,
                functions: {
                    blendEquationSeparate: [
                        WebGLConstants.FUNC_ADD,
                        WebGLConstants.FUNC_ADD
                    ],
                    blendFuncSeparate: [
                        WebGLConstants.ONE,
                        WebGLConstants.ONE_MINUS_SRC_ALPHA,
                        WebGLConstants.ONE,
                        WebGLConstants.ONE_MINUS_SRC_ALPHA
                    ]
                }
            };
        }
        else if (khrMaterialsCommon.doubleSided) {
            techniqueStates = {
                enable: [
                    WebGLConstants.DEPTH_TEST
                ]
            };
        }
        else { // Not transparent or double sided
            techniqueStates = {
                enable: [
                    WebGLConstants.CULL_FACE,
                    WebGLConstants.DEPTH_TEST
                ]
            };
        }
        techniques[techniqueId] = {
            attributes: techniqueAttributes,
            parameters: techniqueParameters,
            program: programId,
            states: techniqueStates,
            uniforms: techniqueUniforms
        };

        // Add shaders
        shaders[vertexShaderId] = {
            type: WebGLConstants.VERTEX_SHADER,
            uri: '',
            extras: {
                source: vertexShader
            }
        };
        shaders[fragmentShaderId] = {
            type: WebGLConstants.FRAGMENT_SHADER,
            uri: '',
            extras: {
                source: fragmentShader
            }
        };

        // Add program
        var programAttributes = Object.keys(techniqueAttributes);
        programs[programId] = {
            attributes: programAttributes,
            fragmentShader: fragmentShaderId,
            vertexShader: vertexShaderId
        };

        return techniqueId;
    }

    function getKHRMaterialsCommonValueType(paramName, paramValue)
    {
        var value;

        // Backwards compatibility for COLLADA2GLTF v1.0-draft when it encoding
        // materials using KHR_materials_common with explicit type/value members
        if (defined(paramValue.value)) {
            value = paramValue.value;
        } else {
            value = paramValue;
        }

        switch (paramName)  {
            case 'ambient':
                return (value instanceof String || typeof value === 'string') ? WebGLConstants.SAMPLER_2D : WebGLConstants.FLOAT_VEC4;
            case 'diffuse':
                return (value instanceof String || typeof value === 'string') ? WebGLConstants.SAMPLER_2D : WebGLConstants.FLOAT_VEC4;
            case 'emission':
                return (value instanceof String || typeof value === 'string') ? WebGLConstants.SAMPLER_2D : WebGLConstants.FLOAT_VEC4;
            case 'specular':
                return (value instanceof String || typeof value === 'string') ? WebGLConstants.SAMPLER_2D : WebGLConstants.FLOAT_VEC4;
            case 'shininess':
                return WebGLConstants.FLOAT;
            case 'transparency':
                return WebGLConstants.FLOAT;

            // these two are usually not used directly within shaders,
            // they are just added here for completeness
            case 'transparent':
                return WebGLConstants.BOOL;
            case 'doubleSided':
                return WebGLConstants.BOOL;
        }
    }

    function getTechniqueKey(khrMaterialsCommon) {
        var techniqueKey = '';
        techniqueKey += 'technique:' + khrMaterialsCommon.technique + ';';

        var values = khrMaterialsCommon.values;
        var keys = Object.keys(values).sort();
        var keysCount = keys.length;
        for (var i=0;i<keysCount;++i) {
            var name = keys[i];
            //generate first part of key using shader parameters for KHR_materials_common attributes
            //(including a check, because some boolean flags should not be used as shader parameters)
            if (values.hasOwnProperty(name) && (name !== 'transparent') && (name !== 'doubleSided')) {
                techniqueKey += name + ':' + getKHRMaterialsCommonValueType(name, values[name]);
                techniqueKey += ';';
            }
        }

        var doubleSided = defaultValue(khrMaterialsCommon.doubleSided, false);
        techniqueKey += doubleSided.toString() + ';';
        var transparent = defaultValue(khrMaterialsCommon.transparent, false);
        techniqueKey += transparent.toString() + ';';
        var jointCount = defaultValue(khrMaterialsCommon.jointCount, 0);
        techniqueKey += jointCount.toString() + ';';

        return techniqueKey;
    }

    /**
     * Modifies gltf in place.
     *
     * @private
     */
    function pbrPipeline(gltf, options) {
        if (!defined(gltf)) {
            return undefined;
        }

        options = defaultValue(options, defaultValue.EMPTY_OBJECT);

        var hasExtension = false;
        var extensionsUsed = gltf.extensionsUsed;
        if (defined(extensionsUsed)) {
            var extensionsUsedCount = extensionsUsed.length;
            for(var i=0;i<extensionsUsedCount;++i) {
                if (extensionsUsed[i] === 'KHR_materials_common') {
                    hasExtension = true;
                    extensionsUsed.splice(i, 1);
                    break;
                }
            }
        }

        if (hasExtension) {
            if (!defined(gltf.programs)) {
                gltf.programs = {};
            }
            if (!defined(gltf.shaders)) {
                gltf.shaders = {};
            }
            if (!defined(gltf.techniques)) {
                gltf.techniques = {};
            }

            var lightParameters = generateLightParameters(gltf);

            var hasCesiumRTCExtension = defined(gltf.extensions) && defined(gltf.extensions.CESIUM_RTC);

            var techniques = {};
            var materials = gltf.materials;
            for (var name in materials) {
                if (materials.hasOwnProperty(name)) {
                    var material = materials[name];
                    if (defined(material.extensions) && defined(material.extensions.KHR_materials_common)) {
                        var khrMaterialsCommon = material.extensions.KHR_materials_common;
                        var techniqueKey = getTechniqueKey(khrMaterialsCommon);
                        var technique = techniques[techniqueKey];
                        if (!defined(technique)) {
                            technique = generateTechnique(gltf, khrMaterialsCommon, lightParameters, {
                                useCesiumRTCMatrixInShaders : hasCesiumRTCExtension
                            });
                            techniques[techniqueKey] = technique;
                        }

                        // Take advantage of the fact that we generate techniques that use the
                        // same parameter names as the extension values.
                        material.values = {};
                        var values = khrMaterialsCommon.values;
                        for (var valueName in values) {
                            if (values.hasOwnProperty(valueName)) {
                                var value = values[valueName];

                                // Backwards compatibility for COLLADA2GLTF v1.0-draft when it encoding
                                // materials using KHR_materials_common with explicit type/value members
                                if (defined(value.value)) {
                                    material.values[valueName] = value.value;
                                } else {
                                    material.values[valueName] = value;
                                }
                            }
                        }

                        material.technique = technique;

                        delete material.extensions.KHR_materials_common;
                    }
                }
            }

            if (defined(gltf.extensions)) {
                delete gltf.extensions.KHR_materials_common;
            }
        }

        return gltf;
    }

    return pbrPipeline;
});
