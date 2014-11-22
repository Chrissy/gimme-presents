class User < ActiveRecord::Base
  serialize :lists, Array
end