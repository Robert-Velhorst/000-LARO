"""
Serverless Architecture Implementation for Legal AI Platform

This module implements serverless architecture components including:
- Serverless function wrappers for Flask routes
- Event-driven architecture for better resource utilization
- Serverless database options for auto-scaling
"""

import os
import json
import time
import uuid
import logging
import threading
import functools
import importlib
from typing import Dict, List, Any, Optional, Callable, Union
from flask import request, jsonify, current_app, g

# Configure logging
logger = logging.getLogger('legal_ai_platform.serverless')

class EventBus:
    """Event bus for event-driven architecture"""
    
    def __init__(self):
        self.subscribers = {}
        self.event_history = []
        self.max_history = 100
        self.lock = threading.RLock()
    
    def publish(self, event_type: str, event_data: Dict[str, Any] = None) -> bool:
        """
        Publish an event to all subscribers
        
        Args:
            event_type: Type of event
            event_data: Event data
        
        Returns:
            True if event was published, False otherwise
        """
        with self.lock:
            if event_type not in self.subscribers:
                logger.debug(f"No subscribers for event type: {event_type}")
                return False
            
            event = {
                'id': str(uuid.uuid4()),
                'type': event_type,
                'data': event_data or {},
                'timestamp': time.time()
            }
            
            # Add to event history
            self.event_history.append(event)
            if len(self.event_history) > self.max_history:
                self.event_history.pop(0)
            
            # Notify subscribers
            for subscriber in self.subscribers[event_type]:
                try:
                    # Execute subscriber callback in a separate thread
                    threading.Thread(
                        target=subscriber,
                        args=(event,),
                        daemon=True
                    ).start()
                except Exception as e:
                    logger.error(f"Error notifying subscriber for event {event_type}: {e}")
            
            logger.debug(f"Published event: {event_type}")
            return True
    
    def subscribe(self, event_type: str, callback: Callable) -> bool:
        """
        Subscribe to an event type
        
        Args:
            event_type: Type of event
            callback: Callback function to execute when event is published
        
        Returns:
            True if subscription was successful, False otherwise
        """
        with self.lock:
            if event_type not in self.subscribers:
                self.subscribers[event_type] = []
            
            self.subscribers[event_type].append(callback)
            logger.debug(f"Subscribed to event: {event_type}")
            return True
    
    def unsubscribe(self, event_type: str, callback: Callable) -> bool:
        """
        Unsubscribe from an event type
        
        Args:
            event_type: Type of event
            callback: Callback function to remove
        
        Returns:
            True if unsubscription was successful, False otherwise
        """
        with self.lock:
            if event_type not in self.subscribers:
                logger.debug(f"No subscribers for event type: {event_type}")
                return False
            
            if callback not in self.subscribers[event_type]:
                logger.debug(f"Callback not found for event type: {event_type}")
                return False
            
            self.subscribers[event_type].remove(callback)
            logger.debug(f"Unsubscribed from event: {event_type}")
            return True
    
    def get_event_history(self, event_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Get event history
        
        Args:
            event_type: Optional event type to filter by
        
        Returns:
            List of events
        """
        with self.lock:
            if event_type:
                return [event for event in self.event_history if event['type'] == event_type]
            else:
                return self.event_history.copy()

class ServerlessFunctionManager:
    """
    Manager class for serverless functions including registration,
    invocation, and monitoring.
    """
    
    def __init__(self):
        self.functions = {}
        self.event_bus = EventBus()
        self.metrics = {
            'invocations': {},
            'errors': {},
            'durations': {}
        }
        
        # Initialize metrics recording
        self._initialize_metrics_recording()
    
    def _initialize_metrics_recording(self):
        """Initialize metrics recording"""
        # Record metrics to time-series database if available
        try:
            from timeseries_manager import timeseries_manager
            self.timeseries_manager = timeseries_manager
        except ImportError:
            logger.warning("Time-series manager not available, metrics will not be recorded")
            self.timeseries_manager = None
    
    def register_function(self, name: str, handler: Callable, options: Dict[str, Any] = None) -> bool:
        """
        Register a serverless function
        
        Args:
            name: Function name
            handler: Function handler
            options: Function options
        
        Returns:
            True if registration was successful, False otherwise
        """
        if name in self.functions:
            logger.warning(f"Function {name} already registered, overwriting")
        
        options = options or {}
        default_options = {
            'timeout': 30000,  # 30 seconds
            'memory_size': 128,  # 128 MB
            'environment': {},
            'concurrency': 100,
            'retries': 3,
            'events': []
        }
        
        function_config = {
            'name': name,
            'handler': handler,
            'options': {**default_options, **options}
        }
        
        self.functions[name] = function_config
        
        # Initialize metrics for this function
        self.metrics['invocations'][name] = 0
        self.metrics['errors'][name] = 0
        self.metrics['durations'][name] = []
        
        # Register event triggers if specified
        if 'events' in options and options['events']:
            for event in options['events']:
                self.event_bus.subscribe(event['type'], lambda event_data: self.invoke_function(name, event_data))
        
        logger.info(f"Registered serverless function: {name}")
        return True
    
    def invoke_function(self, name: str, payload: Dict[str, Any] = None, options: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Invoke a serverless function
        
        Args:
            name: Function name
            payload: Function payload
            options: Invocation options
        
        Returns:
            Function result
        """
        if name not in self.functions:
            logger.error(f"Function {name} not found")
            return {
                'statusCode': 404,
                'body': {'error': f"Function {name} not found"}
            }
        
        function_config = self.functions[name]
        start_time = time.time()
        
        # Increment invocation counter
        self.metrics['invocations'][name] += 1
        
        try:
            logger.info(f"Invoking serverless function: {name}")
            logger.debug("Invoking registered function handler")
            
            # Create context object similar to AWS Lambda
            context = {
                'function_name': name,
                'function_version': '1.0.0',
                'invoked_function_arn': f"arn:aws:lambda:us-east-1:123456789012:function:{name}",
                'memory_limit_in_mb': function_config['options']['memory_size'],
                'aws_request_id': str(uuid.uuid4()),
                'log_group_name': f"/aws/lambda/{name}",
                'log_stream_name': f"2025/04/03/[$LATEST]{self._generate_random_string(32)}",
                'identity': {
                    'cognito_identity_id': None,
                    'cognito_identity_pool_id': None
                },
                'client_context': options.get('client_context') if options else None,
                'get_remaining_time_in_millis': lambda: function_config['options']['timeout'] - int((time.time() - start_time) * 1000),
                'callback_waits_for_empty_event_loop': True
            }
            
            # Execute the function handler
            result = function_config['handler'](payload or {}, context)
            
            # Record duration
            duration = time.time() - start_time
            self.metrics['durations'][name].append(duration)
            
            # Trim durations list if it gets too long
            if len(self.metrics['durations'][name]) > 100:
                self.metrics['durations'][name] = self.metrics['durations'][name][-100:]
            
            # Record metrics to time-series database if available
            if self.timeseries_manager:
                self.timeseries_manager.record_system_metric(
                    metric_type='serverless_invocation',
                    value=duration,
                    component=name,
                    details={
                        'status': 'success',
                        'duration': duration
                    }
                )
            
            logger.info(f"Function {name} executed successfully in {duration:.2f}s")
            return result
        
        except Exception as e:
            # Record error
            self.metrics['errors'][name] += 1
            duration = time.time() - start_time
            
            # Record metrics to time-series database if available
            if self.timeseries_manager:
                self.timeseries_manager.record_system_metric(
                    metric_type='serverless_invocation',
                    value=duration,
                    component=name,
                    details={
                        'status': 'error',
                        'error': type(e).__name__,
                        'duration': duration
                    }
                )
            
            logger.error("Serverless function failed (%s)", type(e).__name__)
            
            # Retry if configured
            retries = options.get('retries', function_config['options']['retries']) if options else function_config['options']['retries']
            if retries > 0:
                logger.info(f"Retrying function {name}, {retries} retries left")
                new_options = options.copy() if options else {}
                new_options['retries'] = retries - 1
                return self.invoke_function(name, payload, new_options)
            
            return {
                'statusCode': 500,
                'body': {'error': 'Serverless function failed'}
            }
    
    def get_function(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a function configuration
        
        Args:
            name: Function name
        
        Returns:
            Function configuration or None if not found
        """
        return self.functions.get(name)
    
    def list_functions(self) -> List[Dict[str, Any]]:
        """
        List all registered functions
        
        Returns:
            List of function configurations
        """
        return [
            {
                'name': name,
                'options': config['options'],
                'metrics': {
                    'invocations': self.metrics['invocations'].get(name, 0),
                    'errors': self.metrics['errors'].get(name, 0),
                    'avg_duration': self._calculate_avg_duration(name)
                }
            }
            for name, config in self.functions.items()
        ]
    
    def _calculate_avg_duration(self, name: str) -> float:
        """
        Calculate average duration for a function
        
        Args:
            name: Function name
        
        Returns:
            Average duration in seconds
        """
        durations = self.metrics['durations'].get(name, [])
        if not durations:
            return 0
        
        return sum(durations) / len(durations)
    
    def _generate_random_string(self, length: int) -> str:
        """
        Generate a random string
        
        Args:
            length: String length
        
        Returns:
            Random string
        """
        import random
        import string
        return ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(length))

# Create a global instance
serverless_manager = ServerlessFunctionManager()

def serverless_function(name: str = None, options: Dict[str, Any] = None):
    """
    Decorator for serverless functions
    
    Args:
        name: Function name (defaults to function name)
        options: Function options
    
    Returns:
        Decorated function
    """
    def decorator(func):
        nonlocal name
        if name is None:
            name = func.__name__
        
        # Register the function with the serverless manager
        serverless_manager.register_function(name, func, options)
        
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Support direct Lambda-style calls used by application code and tests:
            # function(payload, context) or function(payload).
            if not kwargs and args and isinstance(args[0], dict):
                if len(args) == 1 or (len(args) == 2 and isinstance(args[1], dict)):
                    return serverless_manager.invoke_function(name, args[0])

            # Convert args and kwargs to a payload
            payload = {
                'args': args,
                'kwargs': kwargs
            }
            
            # Invoke the function through the serverless manager
            return serverless_manager.invoke_function(name, payload)
        
        return wrapper
    
    return decorator

def flask_route_to_serverless(app, route, methods=None, name=None, options=None):
    """
    Convert a Flask route to a serverless function
    
    Args:
        app: Flask application
        route: Route path
        methods: HTTP methods
        name: Function name
        options: Function options
    
    Returns:
        Flask route function
    """
    methods = methods or ['GET']
    
    def decorator(func):
        nonlocal name
        if name is None:
            name = func.__name__
        
        # Define the serverless handler
        def serverless_handler(payload, context):
            # Create a mock request context
            with app.test_request_context(
                path=route,
                method=payload.get('method', 'GET'),
                data=payload.get('body'),
                headers=payload.get('headers', {}),
                query_string=payload.get('queryStringParameters', {})
            ):
                # Execute the original function
                return func()
        
        # Register the serverless function
        serverless_manager.register_function(name, serverless_handler, options)
        
        # Define the Flask route function
        @app.route(route, methods=methods, endpoint=f"serverless_{name}")
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Convert the Flask request to a serverless payload
            payload = {
                'method': request.method,
                'body': request.get_data(as_text=True),
                'headers': dict(request.headers),
                'queryStringParameters': request.args.to_dict()
            }
            
            # Invoke the serverless function
            result = serverless_manager.invoke_function(name, payload)
            
            # Convert the result to a Flask response
            if isinstance(result, dict) and 'statusCode' in result and 'body' in result:
                return jsonify(result['body']), result['statusCode']
            
            return result
        
        return wrapper
    
    return decorator

def event_handler(event_type: str, name: str = None, options: Dict[str, Any] = None):
    """
    Decorator for event handlers
    
    Args:
        event_type: Event type
        name: Function name (defaults to function name)
        options: Function options
    
    Returns:
        Decorated function
    """
    def decorator(func):
        nonlocal name
        if name is None:
            name = func.__name__
        
        # Define the serverless handler
        def serverless_handler(payload, context):
            # Extract event data
            event_data = payload.get('detail', {})
            
            # Execute the original function
            return func(event_data)
        
        # Set up event options
        handler_options = options or {}
        if 'events' not in handler_options:
            handler_options['events'] = []
        
        handler_options['events'].append({
            'type': event_type
        })
        
        # Register the serverless function
        serverless_manager.register_function(name, serverless_handler, handler_options)
        
        # Subscribe to the event
        serverless_manager.event_bus.subscribe(event_type, lambda event: serverless_manager.invoke_function(name, event))
        
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        
        return wrapper
    
    return decorator

def publish_event(event_type: str, event_data: Dict[str, Any] = None) -> bool:
    """
    Publish an event
    
    Args:
        event_type: Event type
        event_data: Event data
    
    Returns:
        True if event was published, False otherwise
    """
    return serverless_manager.event_bus.publish(event_type, event_data)

def init_app(app):
    """
    Initialize the serverless architecture with the Flask application
    
    Args:
        app: Flask application
    """
    # Add serverless manager to app config for easy access
    app.config['serverless_manager'] = serverless_manager
    
    # Add event bus to app config for easy access
    app.config['event_bus'] = serverless_manager.event_bus
    
    # Register serverless functions for existing routes
    for rule in app.url_map.iter_rules():
        if rule.endpoint != 'static':
            view_func = app.view_functions[rule.endpoint]
            
            # Skip already wrapped functions
            if hasattr(view_func, '_is_serverless'):
                continue
            
            # Create a serverless function for this route
            name = f"route_{rule.endpoint}"
            methods = list(rule.methods - {'HEAD', 'OPTIONS'})
            
            # Wrap the view function
            wrapped_func = flask_route_to_serverless(
                app,
                rule.rule,
                methods=methods,
                name=name
            )(view_func)
            
            # Mark as serverless
            wrapped_func._is_serverless = True
    
    logger.info("Serverless architecture initialized")

# Example usage:
# @serverless_function(options={
#     'timeout': 60000,  # 60 seconds
#     'memory_size': 256,  # 256 MB
#     'events': [
#         {'type': 'case.created'}
#     ]
# })
# def process_new_case(payload, context):
#     case_id = payload.get('case_id')
#     # Process the case
#     return {
#         'statusCode': 200,
#         'body': {'message': f'Processed case {case_id}'}
#     }
#
# @event_handler('user.login')
# def handle_user_login(event_data):
#     user_id = event_data.get('user_id')
#     # Handle user login
#     return {
#         'user_id': user_id,
#         'processed': True
#     }
#
# # Publish an event
# publish_event('case.created', {'case_id': '123'})
